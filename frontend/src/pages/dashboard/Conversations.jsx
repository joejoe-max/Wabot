import { useEffect, useState, useRef } from "react";
import { botsApi } from "../../api/bots.js";
import { Spinner } from "../../components/ui/Spinner.jsx";
import { Modal } from "../../components/ui/Modal.jsx";

const DISMISSED_KEY = "wabot:convs-dismissed";

function loadDismissed() {
  try {
    const raw = localStorage.getItem(DISMISSED_KEY);
    return raw ? JSON.parse(raw) : [];
  } catch (e) { return []; }
}
function saveDismissed(arr) {
  try { localStorage.setItem(DISMISSED_KEY, JSON.stringify(arr)); } catch {}
}

export function Conversations() {
  const [loading, setLoading] = useState(true);
  const [convs, setConvs] = useState([]);
  const [offset, setOffset] = useState(0);
  const [selected, setSelected] = useState(null);
  const [reply, setReply] = useState("");
  const [sending, setSending] = useState(false);
  const [result, setResult] = useState(null);
  const [view, setView] = useState("dm"); // dm | group | all
  const [dismissed, setDismissed] = useState(() => loadDismissed());
  const [persistRead, setPersistRead] = useState(false);

  const touchState = useRef({});

  useEffect(() => {
    let mounted = true;
    botsApi.v1Conversations(undefined, 50, offset).then((d) => {
      if (!mounted) return;
      setConvs(d.conversations ?? []);
      setLoading(false);
    }).catch(() => { if (mounted) setLoading(false); });
    return () => mounted = false;
  }, [offset]);

  useEffect(() => { saveDismissed(dismissed); }, [dismissed]);

  const open = (c) => setSelected(c);
  const close = () => { setSelected(null); setReply(""); setResult(null); };

  const isGroupConv = (c) => {
    if (c?.metadata?.isGroup !== undefined) return Boolean(c.metadata.isGroup);
    if (c?.metadata?.from) return String(c.metadata.from).includes("@g.") || String(c.metadata.from).includes("@g.us");
    return String(c?.details ?? "").includes("@g.") || String(c?.details ?? "").includes("@g.us");
  };

  const visibleConvs = convs
    .filter((c) => c.event_type === "message_received")
    .filter((c) => !dismissed.includes(c.id))
    .filter((c) => {
      if (view === "all") return true;
      return view === "group" ? isGroupConv(c) : !isGroupConv(c);
    });

  const dismiss = (id) => {
    setDismissed((s) => {
      const next = Array.from(new Set([...(s || []), id]));
      saveDismissed(next);
      return next;
    });
    setConvs((s) => s.filter((c) => c.id !== id));
    // Persist read state to server if enabled
    if (persistRead) {
      botsApi.v1MarkConversationsRead([id]).catch(() => {});
    }
    if (selected?.id === id) close();
  };

  const markVisibleRead = async () => {
    const ids = visibleConvs.map((c) => c.id);
    setDismissed((s) => Array.from(new Set([...(s || []), ...ids])));
    setConvs((s) => s.filter((c) => !ids.includes(c.id)));
    if (persistRead && ids.length) {
      await botsApi.v1MarkConversationsRead(ids).catch(() => {});
    }
  };

  const handleTouchStart = (e, id) => {
    const t = e.touches?.[0];
    if (!t) return;
    touchState.current[id] = { startX: t.clientX, deltaX: 0 };
  };
  const handleTouchMove = (e, id) => {
    const t = e.touches?.[0];
    if (!t || !touchState.current[id]) return;
    touchState.current[id].deltaX = t.clientX - touchState.current[id].startX;
    const el = document.getElementById(`conv-${id}`);
    if (el) {
      const dx = Math.max(-160, Math.min(0, touchState.current[id].deltaX));
      el.style.transform = `translateX(${dx}px)`;
      el.style.transition = "transform 0s";
    }
  };
  const handleTouchEnd = (e, id) => {
    const state = touchState.current[id];
    if (!state) return;
    const el = document.getElementById(`conv-${id}`);
    const dx = state.deltaX;
    if (el) {
      el.style.transition = "transform 200ms ease";
      if (dx <= -80) {
        el.style.transform = `translateX(-100%)`;
        setTimeout(() => dismiss(id), 180);
      } else {
        el.style.transform = "translateX(0)";
      }
    }
    delete touchState.current[id];
  };

  const doReply = async () => {
    if (!selected) return;
    setSending(true); setResult(null);
    const to = selected.metadata?.from ?? selected.details;
    const msg = (reply || selected.metadata?.preview || "").toString();
    try {
      // Use non-persistent dashboard send so we don't create DB activity here
      await botsApi.sendDM(selected.bot_id, { to, message: msg });
      setResult({ ok: true, text: "Reply sent" });
      // remove from visible list until a new incoming message arrives
      dismiss(selected.id);
    } catch (err) {
      setResult({ ok: false, text: err?.message || String(err) });
    } finally { setSending(false); }
  };

  if (loading) return <div style={{ padding: 20 }}><Spinner size="lg" /></div>;

  return (
    <div style={{ display: "flex", gap: "1rem" }}>
      <div style={{ width: 360 }}>
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 8 }}>
          <div style={{ fontWeight: 700 }}>Conversations</div>
          <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
            <button className={`btn ${view==="dm"?"btn-primary":"btn-ghost"}`} onClick={() => setView("dm")}>DMs</button>
            <button className={`btn ${view==="group"?"btn-primary":"btn-ghost"}`} onClick={() => setView("group")}>Groups</button>
            <button className={`btn ${view==="all"?"btn-primary":"btn-ghost"}`} onClick={() => setView("all")}>All</button>
            <button className="btn btn-ghost" onClick={() => setOffset(Math.max(0, offset - 50))} title="Prev">←</button>
            <button className="btn btn-ghost" onClick={() => setOffset(offset + 50)} title="Next">→</button>
            <label style={{ display: "flex", gap: 6, alignItems: "center", marginLeft: 8 }}>
              <input type="checkbox" checked={persistRead} onChange={(e) => setPersistRead(e.target.checked)} />
              <span style={{ fontSize: "0.85rem" }}>Persist reads</span>
            </label>
            <button className="btn btn-ghost" onClick={markVisibleRead}>Mark all read</button>
          </div>
        </div>

        {visibleConvs.length === 0 && <div className="card">No recent conversations.</div>}
        {visibleConvs.map((c) => (
          <div
            id={`conv-${c.id}`}
            key={c.id}
            className="card"
            style={{ marginBottom: 8, cursor: "pointer", touchAction: "pan-y" }}
            onClick={() => open(c)}
            onTouchStart={(e) => handleTouchStart(e, c.id)}
            onTouchMove={(e) => handleTouchMove(e, c.id)}
            onTouchEnd={(e) => handleTouchEnd(e, c.id)}
          >
            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
              <div style={{ fontWeight: 600 }}>{c.bot_id}</div>
              <button className="btn btn-ghost" onClick={(ev) => { ev.stopPropagation(); dismiss(c.id); }}>Dismiss</button>
            </div>
            <div style={{ color: "var(--text3)", fontSize: "0.9rem" }}>{c.details}</div>
            <div style={{ fontSize: "0.8rem", color: "var(--text2)", marginTop: 6 }}>{new Date(c.created_at).toLocaleString()}</div>
          </div>
        ))}
      </div>

      <div style={{ flex: 1 }}>
        <div style={{ fontWeight: 700, marginBottom: 8 }}>Preview</div>
        {!selected && <div className="card">Select a conversation to reply.</div>}
        {selected && (
          <div>
            <div className="card" style={{ marginBottom: 8 }}>
              <div style={{ fontWeight: 700 }}>{selected.details}</div>
              <div style={{ color: "var(--text3)", fontSize: "0.9rem" }}>{JSON.stringify(selected.metadata ?? {})}</div>
            </div>

            <div className="field">
              <label className="field-label">Reply</label>
              <textarea className="input" rows={5} value={reply} onChange={(e) => setReply(e.target.value)} />
            </div>

            {result && <div className={result.ok ? "alert alert-success" : "alert alert-error"} style={{ marginBottom: 8 }}>{result.text}</div>}

            <div style={{ display: "flex", gap: 8 }}>
              <button className="btn btn-primary" disabled={sending || reply.trim().length === 0} onClick={doReply}>{sending ? "Sending…" : "Send reply"}</button>
              <button className="btn btn-ghost" onClick={close}>Close</button>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

export default Conversations;
