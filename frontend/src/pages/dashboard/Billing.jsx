import { useEffect, useState } from "react";
import { PlanBadge }  from "../../components/ui/Badge.jsx";
import { Spinner }    from "../../components/ui/Spinner.jsx";
import { Alert }      from "../../components/ui/Alert.jsx";
import { billingApi } from "../../api/billing.js";

const FEATURES = [
  { label: "Bots",                free: "1",       pro: "50"       },
  { label: "Messages / month",    free: "1,000",   pro: "100,000"  },
  { label: "API keys",            free: "1",       pro: "10"       },
  { label: "Message templates",   free: "10",      pro: "200"      },
  { label: "QR deployment",       free: "✓",       pro: "✓"        },
  { label: "Webhooks",            free: "✓",       pro: "✓"        },
  { label: "Auto-reply",          free: "✓",       pro: "✓"        },
  { label: "AI integration",      free: "—",       pro: "✓"        },
  { label: "Broadcast messages",  free: "—",       pro: "✓"        },
  { label: "Activity logs",       free: "✓",       pro: "✓"        },
  { label: "Priority support",    free: "—",       pro: "✓"        },
  { label: "Subscription portal", free: "—",       pro: "✓"        },
];

function fmtDate(iso) {
  if (!iso) return null;
  return new Date(iso).toLocaleDateString(undefined, { year: "numeric", month: "long", day: "numeric" });
}

const STATUS_INFO = {
  active:   { color: "var(--success)", label: "Active" },
  past_due: { color: "var(--warning)", label: "Past due — payment failed" },
  inactive: { color: "var(--error)",   label: "Inactive" },
  canceled: { color: "var(--text3)",   label: "Cancelled" },
};

export function Billing({ user, onUpgrade, upgrading, upgradeError, onManage, managing }) {
  const isPro = user?.plan_tier === "paid";
  const canUseProFromSubscription = (status) => status === "active";

  const [sub,           setSub]           = useState(null);
  const [subLoading,    setSubLoading]    = useState(false);
  const [billingConfigured, setBillingConfigured] = useState(true);
  const [manageErr,     setManageErr]     = useState("");
  const [cancelling,    setCancelling]    = useState(false);
  const [cancelErr,     setCancelErr]     = useState("");
  const [cancelSuccess, setCancelSuccess] = useState(false);
  const [showCancelConfirm, setShowCancelConfirm] = useState(false);
  const [showBillingPopup, setShowBillingPopup] = useState(false);
  const [billingPopupMsg, setBillingPopupMsg] = useState("");

  useEffect(() => {
    setSubLoading(true);
    billingApi.status()
      .then((d) => {
        setBillingConfigured(d.configured !== false);
        setSub(d.subscription ?? null);
      })
      .catch(() => {
        setBillingConfigured(false);
        setSub(null);
      })
      .finally(() => setSubLoading(false));
  }, [isPro]);

  const handleManage = async () => {
    setManageErr("");
    try {
      await onManage();
    } catch (err) {
      if (err?.status === 503) {
        setBillingPopupMsg(err.message || "Billing is not confirmed on this server.");
        setShowBillingPopup(true);
        return;
      }
      setManageErr(err.message);
    }
  };

  const handleUpgrade = async () => {
    if (!billingConfigured) {
      setBillingPopupMsg("Pro features aren't available yet on this deployment. Please continue using the Free plan for now.");
      setShowBillingPopup(true);
      return;
    }
    try {
      await onUpgrade();
    } catch (err) {
      if (err?.status === 503) {
        setBillingPopupMsg(err.message || "Billing is not confirmed on this server.");
        setShowBillingPopup(true);
      }
      /* Non-503 errors: already shown via the upgradeError prop set by Dashboard */
    }
  };

  const handleCancel = async () => {
    setCancelErr("");
    setCancelling(true);
    try {
      await billingApi.cancel();
      setCancelSuccess(true);
      setShowCancelConfirm(false);
      setSub((s) => s ? { ...s, status: "canceled" } : s);
    } catch (err) {
      setCancelErr(err.message ?? "Could not cancel subscription. Please try again.");
    } finally {
      setCancelling(false);
    }
  };

  const subStatus  = sub?.status ?? null;
  const statusInfo = STATUS_INFO[subStatus] ?? null;
  const renewDate  = sub?.currentPeriodEnd ? fmtDate(sub.currentPeriodEnd) : null;
  const isPastDue  = subStatus === "past_due";
  const isCanceled = subStatus === "canceled";
  const isActive   = subStatus === "active";

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: "1.25rem" }}>
      {showBillingPopup && (
        <div className="modal-backdrop" onClick={() => setShowBillingPopup(false)}>
          <div className="modal" onClick={(e) => e.stopPropagation()} style={{ maxWidth: 520 }}>
            <div className="section-heading" style={{ marginBottom: "0.75rem" }}>
              <span>Billing not confirmed</span>
            </div>
            <p style={{ color: "var(--text2)", lineHeight: 1.6, marginBottom: "1rem" }}>
              {billingPopupMsg || "Billing is not confirmed on this server."}
            </p>
            <div style={{ display: "flex", justifyContent: "flex-end" }}>
              <button className="btn btn-primary" onClick={() => setShowBillingPopup(false)}>
                OK
              </button>
            </div>
          </div>
        </div>
      )}

      <div className="section-heading"><span>Billing</span></div>

      {upgradeError  && <Alert type="error">{upgradeError}</Alert>}
      {manageErr     && <Alert type="error">{manageErr}</Alert>}
      {cancelErr     && <Alert type="error">{cancelErr}</Alert>}
      {cancelSuccess && <Alert type="success">Subscription cancelled. Your account has been moved back to the Free plan.</Alert>}
      {!billingConfigured && (
        <Alert type="warning">
          Pro billing is not configured on this deployment yet. Add `PAYSTACK_SECRET_KEY`, `PAYSTACK_PLAN_CODE`, and `PAYSTACK_WEBHOOK_SECRET` on the backend to enable upgrades.
        </Alert>
      )}

      {isPastDue && (
        <Alert type="error">
          Your last payment failed. Please update your payment method to keep Pro access.
        </Alert>
      )}

      {isCanceled && isPro && (
        <Alert type="warning">
          Your subscription has been cancelled. You still have Pro access until {renewDate ?? "the end of the billing period"}.
        </Alert>
      )}

      <div className="card card-accent">
        <div style={{ display: "flex", alignItems: "flex-start", gap: "1rem", flexWrap: "wrap" }}>
          <div style={{ fontSize: "2rem" }}>💳</div>
          <div style={{ flex: 1, minWidth: 0 }}>
            <div style={{ display: "flex", alignItems: "center", gap: "0.5rem", marginBottom: "0.375rem", flexWrap: "wrap" }}>
              <span style={{ fontWeight: 700 }}>Current plan</span>
              <PlanBadge plan={user?.plan_tier} />
              {statusInfo && (
                <span style={{
                  fontSize: "0.72rem", fontWeight: 600,
                  color: statusInfo.color,
                  background: statusInfo.color + "18",
                  padding: "2px 8px", borderRadius: 20
                }}>{statusInfo.label}</span>
              )}
            </div>

            {isPro ? (
              <>
                <div className="text-sm text-muted">50 bots · 100,000 messages/month · AI integration · Priority support</div>
                {subLoading ? (
                  <div style={{ marginTop: "0.5rem", display: "flex", alignItems: "center", gap: "0.5rem" }}>
                    <Spinner size="sm" />
                    <span style={{ fontSize: "0.8rem", color: "var(--text3)" }}>Loading billing info…</span>
                  </div>
                ) : renewDate ? (
                  <div style={{ marginTop: "0.5rem", fontSize: "0.8125rem", color: "var(--text2)" }}>
                    {isCanceled
                      ? `Access until: ${renewDate}`
                      : `Renews: ${renewDate}`}
                  </div>
                ) : null}
              </>
            ) : (
              <div className="text-sm text-muted">1 bot · 1,000 messages/month · Free forever</div>
            )}
          </div>

          {isPro ? (
            <button className="btn btn-secondary" onClick={handleManage} disabled={managing}>
              {managing ? <><Spinner size="sm" /> Opening…</> : "Manage subscription"}
            </button>
          ) : (
            <button className="btn btn-primary" onClick={handleUpgrade} disabled={upgrading}>
              {upgrading ? <><Spinner size="sm" /> Redirecting…</> : "Upgrade to Pro"}
            </button>
          )}
        </div>
      </div>

      {!isPro && (
        <div className="upgrade-banner">
          <div>
            <div style={{ fontWeight: 700, marginBottom: "0.25rem" }}>
              WaBot Pro — ₦1,500 / month
            </div>
            <div className="text-sm text-muted">
              50 bots · 100,000 messages/month · 10 API keys · AI · Broadcast · Priority support
            </div>
          </div>
          <button className="btn btn-primary" onClick={handleUpgrade} disabled={upgrading}>
            {upgrading ? <Spinner size="sm" /> : "Upgrade now"}
          </button>
        </div>
      )}

      {isPro && (
        <div className="card" style={{ background: "var(--bg)", border: "1px solid var(--border)" }}>
          <div style={{ display: "flex", alignItems: "center", gap: "0.75rem", flexWrap: "wrap" }}>
            <span style={{ fontSize: "1.25rem" }}>⚙️</span>
            <div style={{ flex: 1 }}>
              <div style={{ fontWeight: 600, fontSize: "0.875rem", marginBottom: "0.25rem" }}>
                Manage your subscription
              </div>
              <div style={{ fontSize: "0.8rem", color: "var(--text2)" }}>
                Update your payment method or view your subscription details on Paystack.
              </div>
            </div>
            <button className="btn btn-secondary btn-sm" onClick={handleManage} disabled={managing}>
              {managing ? <Spinner size="sm" /> : "Open on Paystack ↗"}
            </button>
          </div>

          {isActive && !cancelSuccess && (
            <div style={{ marginTop: "1rem", paddingTop: "1rem", borderTop: "1px solid var(--border)" }}>
              {!showCancelConfirm ? (
                <button
                  className="btn btn-ghost btn-sm"
                  style={{ color: "var(--error)", fontSize: "0.8rem" }}
                  onClick={() => setShowCancelConfirm(true)}>
                  Cancel subscription
                </button>
              ) : (
                <div style={{ display: "flex", flexDirection: "column", gap: "0.75rem" }}>
                  <div style={{ fontSize: "0.875rem", color: "var(--text2)" }}>
                    <strong>Are you sure?</strong> Cancelling stops renewal and downgrades your account to Free right away.
                  </div>
                  <div style={{ display: "flex", gap: "0.5rem" }}>
                    <button
                      className="btn btn-sm"
                      style={{ background: "var(--error)", color: "#fff", border: "none" }}
                      onClick={handleCancel}
                      disabled={cancelling}>
                      {cancelling ? <><Spinner size="sm" /> Cancelling…</> : "Yes, cancel now"}
                    </button>
                    <button
                      className="btn btn-secondary btn-sm"
                      onClick={() => { setShowCancelConfirm(false); setCancelErr(""); }}
                      disabled={cancelling}>
                      Keep subscription
                    </button>
                  </div>
                </div>
              )}
            </div>
          )}
        </div>
      )}

      <div className="card">
        <div className="section-heading" style={{ marginBottom: "1rem" }}>
          <span>Plan comparison</span>
        </div>
        <div className="table-wrap">
          <table>
            <thead>
              <tr>
                <th style={{ width: "50%" }}>Feature</th>
                <th style={{ textAlign: "center" }}>Free</th>
                <th style={{ textAlign: "center", color: isPro ? "var(--success)" : "var(--accent)" }}>
                  Pro · ₦1,500/mo
                </th>
              </tr>
            </thead>
            <tbody>
              {FEATURES.map(({ label, free, pro }) => (
                <tr key={label}>
                  <td>{label}</td>
                  <td style={{ textAlign: "center", color: free === "—" ? "var(--text3)" : undefined }}>{free}</td>
                  <td style={{
                    textAlign: "center",
                    color: pro === "—" ? "var(--text3)" : "var(--success)",
                    fontWeight: pro !== "—" && pro !== "✓" ? 600 : undefined
                  }}>{pro}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>

      {isPro && (
        <div style={{ fontSize: "0.775rem", color: "var(--text3)", textAlign: "center" }}>
          Subscriptions are billed monthly via Paystack. Cancellations take effect immediately.
          Monthly message limits reset automatically each billing cycle.
        </div>
      )}
    </div>
  );
}
