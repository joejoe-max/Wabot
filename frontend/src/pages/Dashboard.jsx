import { useState, useEffect, useCallback } from "react";
import { useNavigate } from "react-router-dom";
import { useAuth } from "../context/AuthContext.jsx";
import { useTheme } from "../context/ThemeContext.jsx";
import { useDashboard } from "../hooks/useDashboard.js";
import { billingApi } from "../api/billing.js";
import { PageSpinner } from "../components/ui/Spinner.jsx";
import { Overview } from "./dashboard/Overview.jsx";
import { Bots } from "./dashboard/Bots.jsx";
import Conversations from "./dashboard/Conversations.jsx";
import { Logs } from "./dashboard/Logs.jsx";
import { ApiKeys } from "./dashboard/ApiKeys.jsx";
import { Billing } from "./dashboard/Billing.jsx";
import { Settings } from "./dashboard/Settings.jsx";
import { ResendVerificationModal } from "../components/auth/ResendVerificationModal.jsx";
import Admin from "./Admin.jsx";  // ← ADD THIS LINE

// Base tabs for all users
const BASE_TABS = [
  { id: "overview", icon: "⊞", label: "Overview" },
  { id: "conversations", icon: "💬", label: "Conversations" },
  { id: "bots", icon: "🤖", label: "Bots" },
  { id: "logs", icon: "📋", label: "Logs" },
  { id: "apikeys", icon: "🔑", label: "API Keys" },
  { id: "billing", icon: "💳", label: "Billing" },
  { id: "settings", icon: "⚙", label: "Settings" },
];

// Admin-only tab - only shown to superadmins
const ADMIN_TAB = { id: "admin", icon: "🛡️", label: "Admin" };

const EXTERNAL_LINKS = [{ href: "/docs", icon: "📖", label: "API Docs" }];

export default function Dashboard() {
  const auth = useAuth();
  const navigate = useNavigate();
  const { data, loading, refresh } = useDashboard();

  const [tab, setTab] = useState("overview");
  const [showVerifyModal, setShowVerifyModal] = useState(false);

  const { theme, toggle: toggleTheme } = useTheme();

  const [upgrading, setUpgrading] = useState(false);
  const [upgradeError, setUpgradeError] = useState("");
  const [managing, setManaging] = useState(false);
  const [sidebarOpen, setSidebar] = useState(false);

  const user = data.user ?? auth.user;
  const emailVerified = user?.emailVerified ?? user?.email_verified;
  const userEmail = user?.email ?? user?.email_address;
  
  // Check if user is superadmin (from the /me endpoint)
  const isSuperAdmin = user?.isSuperAdmin === true;

  // Build tabs dynamically - add Admin tab only for superadmins
  const TABS = isSuperAdmin ? [...BASE_TABS, ADMIN_TAB] : BASE_TABS;

  /* Switch to billing tab if redirected back from Paystack checkout */
  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    if (params.get("billing")) {
      setTab("billing");
      window.history.replaceState({}, "", window.location.pathname);
    }
  }, []);

  /* Open verification modal for unverified users */
  useEffect(() => {
    if (emailVerified === false) setShowVerifyModal(true);
  }, [emailVerified]);

  /* Allow Overview CTA to open the modal via a global event */
  useEffect(() => {
    const handler = () => setShowVerifyModal(true);
    window.addEventListener("wabot:open-resend-verification", handler);
    return () => window.removeEventListener("wabot:open-resend-verification", handler);
  }, []);

  const handleUpgrade = useCallback(async () => {
    setUpgradeError("");
    setUpgrading(true);
    try {
      const { url } = await billingApi.checkout();
      if (url) window.location.href = url;
    } catch (err) {
      setUpgradeError(err.message ?? "Could not start checkout. Please try again.");
      throw err;
    } finally {
      setUpgrading(false);
    }
  }, []);

  const handleManage = useCallback(async () => {
    setManaging(true);
    try {
      const { url } = await billingApi.portal();
      if (url) window.location.href = url;
    } catch (err) {
      throw err;
    } finally {
      setManaging(false);
    }
  }, []);

  const handleLogout = () => {
    auth.logout();
    navigate("/", { replace: true });
  };

  if (loading && !data.bots.length) return <PageSpinner />;

  return (
    <div className="dash-layout">
      {showVerifyModal && (
        <ResendVerificationModal
          open={showVerifyModal}
          email={userEmail}
          onClose={() => setShowVerifyModal(false)}
          onResent={() => setShowVerifyModal(true)}
        />
      )}

      {/* Sidebar */}
      <aside className={`sidebar ${sidebarOpen ? "sidebar-open" : ""}`}>
        <div className="sidebar-logo">
          <img
            src="/logo.svg"
            alt="WaBot"
            width={28}
            height={28}
            onError={(e) => (e.target.style.display = "none")}
          />
          <span>WaBot</span>
        </div>

        <nav className="sidebar-nav">
          {TABS.map(({ id, icon, label }) => (
            <button
              key={id}
              className={`nav-item ${tab === id ? "active" : ""}`}
              onClick={() => {
                setTab(id);
                setSidebar(false);
              }}
            >
              <span className="nav-icon">{icon}</span>
              <span className="nav-label">{label}</span>
            </button>
          ))}
        </nav>

        {/* External links */}
        <div style={{ padding: "0 0.625rem 0.25rem" }}>
          {EXTERNAL_LINKS.map(({ href, icon, label }) => (
            <a
              key={href}
              href={href}
              target="_blank"
              rel="noreferrer"
              className="nav-item"
              style={{ textDecoration: "none" }}
            >
              <span className="nav-icon">{icon}</span>
              <span className="nav-label">{label}</span>
              <span style={{ fontSize: "0.65rem", color: "var(--text3)", marginLeft: "auto" }}>↗</span>
            </a>
          ))}
        </div>

        <div className="sidebar-footer">
          <div className="sidebar-user">
            <div className="sidebar-avatar">
              {(user?.full_name ?? user?.fullName ?? user?.email ?? "?")[0].toUpperCase()}
            </div>
            <div className="sidebar-user-info">
              <div className="sidebar-user-name">{user?.full_name ?? user?.fullName ?? "Account"}</div>
              <div className="sidebar-user-email">{user?.email}</div>
            </div>
          </div>

          <button
            className="btn btn-ghost btn-sm"
            style={{ width: "100%", marginTop: "0.5rem" }}
            onClick={handleLogout}
          >
            Sign out
          </button>
        </div>
      </aside>

      {/* Mobile overlay */}
      {sidebarOpen && <div className="sidebar-overlay" onClick={() => setSidebar(false)} />}

      {/* Main content */}
      <main className="dash-main">
        <header className="dash-topbar">
          <button className="btn-hamburger" onClick={() => setSidebar((o) => !o)}>
            ☰
          </button>
          <h1 className="dash-page-title">{TABS.find((t) => t.id === tab)?.label ?? "Dashboard"}</h1>
          <button
            className="btn-theme"
            onClick={toggleTheme}
            title={theme === "dark" ? "Switch to light mode" : "Switch to dark mode"}
            aria-label="Toggle theme"
          >
            {theme === "dark" ? "☀️" : "🌙"}
          </button>
        </header>

        <div className="dash-content">
          {tab === "overview" && (
            <Overview
              data={data}
              onGoToBots={() => setTab("bots")}
              onResendVerification={() => setShowVerifyModal(true)}
            />
          )}
          {tab === "conversations" && <Conversations />}
          {tab === "bots" && <Bots data={data} onRefresh={refresh} />}
          {tab === "logs" && <Logs activity={data.activity} bots={data.bots} />}
          {tab === "apikeys" && <ApiKeys user={user} />}
          {tab === "billing" && (
            <Billing
              user={user}
              onUpgrade={handleUpgrade}
              upgrading={upgrading}
              upgradeError={upgradeError}
              onManage={handleManage}
              managing={managing}
            />
          )}
          {tab === "settings" && (
            <Settings user={user} onUserUpdated={(updated) => auth.patchUser(updated)} />
          )}
          {tab === "admin" && <Admin />}  {/* ← ADD THIS LINE */}
        </div>
      </main>
    </div>
  );
}