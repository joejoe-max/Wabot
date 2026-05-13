import { Link } from "react-router-dom";
import { StatusBadge } from "../../components/ui/Badge.jsx";
import { EmptyState } from "../../components/ui/EmptyState.jsx";
import { timeAgo, fmtNumber } from "../../utils/format.js";

export function Overview({ data, onGoToBots, onResendVerification }) {
  const { user, bots, activity, stats } = data;
  const isPro = user?.plan_tier === "paid";

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: "1.25rem" }}>
      {/* Stats grid */}
      <div className="stats-grid">
        {[
          { icon: "🤖", value: stats?.totalBots ?? bots.length,  label: "Total bots"   },
          { icon: "✅", value: stats?.activeBots ?? 0,            label: "Connected now" },
          { icon: "💬", value: fmtNumber(stats?.totalMessages),   label: "All-time msgs" },
          { icon: "📦", value: `${bots.length}/${stats?.planLimit ?? (isPro ? 50 : 1)}`, label: "Bot slots" },
        ].map(({ icon, value, label }) => (
          <div className="stat-card" key={label}>
            <div className="stat-icon">{icon}</div>
            <div className="stat-value">{value}</div>
            <div className="stat-label">{label}</div>
          </div>
        ))}
      </div>

      {/* Email verification CTA */}
      {!user?.email_verified && (
        <div className="card" style={{ background: "var(--card2)" }}>
          <div style={{ display: "flex", alignItems: "flex-start", gap: "0.85rem" }}>
            <div style={{ fontSize: "1.2rem", flexShrink: 0 }}>⚠️</div>
            <div style={{ flex: 1, minWidth: 0 }}>
              <div style={{ fontWeight: 800, marginBottom: "0.35rem" }}>Verify your email to unlock Pro features</div>
              <div style={{ color: "var(--text2)", fontSize: "0.875rem", lineHeight: 1.6 }}>
                Check your inbox for the verification email. If you didn’t receive it, you can resend it from your dashboard.
              </div>
              <div style={{ marginTop: "0.75rem", display: "flex", gap: "0.5rem", flexWrap: "wrap" }}>
                <button
                  className="btn btn-primary btn-sm"
                  onClick={onResendVerification}
                >
                  Resend verification email
                </button>
                <Link to="/verify" className="btn btn-secondary btn-sm" style={{ textDecoration: "none" }}>
                  I have a token
                </Link>
              </div>
            </div>
          </div>
        </div>
      )}

      {/* Monthly usage */}
      {stats?.msgLimit && (
        <div className="card">
          <div className="section-heading" style={{ marginBottom: "0.75rem" }}>
            <span>Monthly usage</span>
            <span style={{ fontSize: "0.8125rem", color: "var(--text2)" }}>
              {fmtNumber(stats.messagesMonth)} / {fmtNumber(stats.msgLimit)} messages
            </span>
          </div>
          <div style={{ background: "var(--bg)", borderRadius: "100px", height: "6px", overflow: "hidden" }}>
            <div style={{
              background:   "var(--accent)",
              height:       "100%",
              width:        `${Math.min(100, ((stats.messagesMonth ?? 0) / stats.msgLimit) * 100)}%`,
              borderRadius: "100px",
              transition:   "width 0.4s ease"
            }} />
          </div>
          <div style={{ fontSize: "0.75rem", color: "var(--text3)", marginTop: "0.5rem" }}>
            Resets monthly · {isPro ? "Pro plan" : "Free plan"}
          </div>
        </div>
      )}

      {/* Recent bots */}
      <div className="card">
        <div className="section-heading" style={{ marginBottom: "1rem" }}>
          <span>Recent Bots</span>
          <button className="btn btn-sm btn-secondary" onClick={onGoToBots}>View all</button>
        </div>
        {bots.length === 0 ? (
          <EmptyState icon="🤖" title="No bots yet" desc="Deploy your first WhatsApp bot to get started."
            action={<button className="btn btn-primary btn-sm" onClick={onGoToBots}>Deploy a bot</button>} />
        ) : (
          <div className="activity-list">
            {bots.slice(0, 5).map((b) => (
              <div className="activity-row" key={b.id}>
                <div className="activity-dot" />
                <div className="flex-1">
                  <div className="activity-event">{b.bot_name}</div>
                  {b.description && <div className="activity-detail">{b.description}</div>}
                  <div className="activity-detail">
                    {fmtNumber(b.messages_count ?? 0)} total · {fmtNumber(b.messages_this_month ?? 0)} this month
                  </div>
                </div>
                <div style={{ display: "flex", alignItems: "center", gap: "0.75rem" }}>
                  <StatusBadge status={b.status} />
                  <div className="activity-time">{timeAgo(b.created_at)}</div>
                </div>
              </div>
            ))}
          </div>
        )}
      </div>

      {/* Recent activity */}
      {activity.length > 0 && (
        <div className="card">
          <div className="section-heading" style={{ marginBottom: "1rem" }}>
            <span>Recent Activity</span>
          </div>
          <div className="activity-list">
            {activity.slice(0, 8).map((a) => (
              <div className="activity-row" key={a.id}>
                <div className="activity-dot" />
                <div className="flex-1">
                  <div className="activity-event">{a.event_type.replace(/_/g, " ")}</div>
                  {a.details && <div className="activity-detail">{a.details}</div>}
                </div>
                <div className="activity-time">{timeAgo(a.created_at)}</div>
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}
