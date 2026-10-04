import { useEffect } from "react";
import { createPortal } from "react-dom";
import { Download, RefreshCw, X } from "lucide-react";
import { clientUpdate, isDesktopClient, startClientUpdates, useClientUpdateStore } from "@/services/clientUpdate";
import { APP_VERSION } from "@/lib/appVersion";

export function ClientUpdateButton() {
  const phase = useClientUpdateStore(s => s.phase);
  if (!isDesktopClient()) return null;
  return <button className="Qiji-titlebar__history-trigger" onClick={() => void clientUpdate.check(true)} title="检查客户端更新">
    <Download size={13} style={{ display: "inline", marginRight: 4 }} />
    {phase === "ready" ? "安装更新" : phase === "downloading" ? "更新下载中" : "检查更新"}
  </button>;
}

export function ClientUpdateNotice() {
  const s = useClientUpdateStore();
  useEffect(startClientUpdates, []);
  useEffect(() => {
    if (s.phase !== "installing") return;
    const block = (e: KeyboardEvent) => { e.preventDefault(); e.stopImmediatePropagation(); };
    window.addEventListener("keydown", block, true);
    return () => window.removeEventListener("keydown", block, true);
  }, [s.phase]);
  if (!isDesktopClient() || !s.visible) return null;
  const installing = s.phase === "installing";
  const percent = s.total ? Math.min(100, Math.round(s.downloaded / s.total * 100)) : null;
  return createPortal(<>
    {installing && <div style={{ position: "fixed", inset: 0, zIndex: 99998, background: "#0009" }} onKeyDown={e => e.stopPropagation()} />}
    <section role="dialog" aria-label="客户端更新" aria-modal={installing || undefined} style={{ position: "fixed", right: 24, bottom: 24, zIndex: 99999,
      width: 370, maxWidth: "calc(100vw - 48px)", padding: 20, borderRadius: 14, background: "#191d28", color: "#eee", border: "1px solid #41495e", boxShadow: "0 12px 48px #0007", fontSize: 14 }}>
      <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 12 }}><RefreshCw size={18} color="#6890f8" />
        <strong style={{ flex: 1 }}>客户端更新</strong>
        {!installing && <button onClick={() => clientUpdate.dismiss()} aria-label="关闭更新提示"><X size={18} /></button>}
      </div>
      <div style={{ color: "#aab1c2", marginBottom: 8 }}>当前 v{APP_VERSION}{s.version && ` → v${s.version}`}</div>
      <p role="status">{s.message}</p>
      {s.phase === "downloading" && <div style={{ marginTop: 12 }}>
        <progress max={100} value={percent ?? undefined} style={{ width: "100%", accentColor: "#6890f8" }} />
        <div>{percent == null ? "已下载" : `${percent}% · 已下载`} {(s.downloaded / 1024 / 1024).toFixed(1)} MB</div>
      </div>}
      {s.notes && <p style={{ whiteSpace: "pre-wrap", maxHeight: 150, overflow: "auto", color: "#b9c0cf", marginTop: 12 }}>{s.notes}</p>}
      <div style={{ display: "flex", justifyContent: "flex-end", gap: 12, marginTop: 16 }}>
        {!installing && <button onClick={() => clientUpdate.dismiss()}>稍后</button>}
        {s.phase === "ready" && <button style={{ background: "#6890f8", color: "white", padding: "8px 12px", borderRadius: 8 }} onClick={() => void clientUpdate.install()}>保存并重启安装</button>}
        {(s.phase === "error" || s.phase === "idle") && <button onClick={() => void clientUpdate.check(true)}>重新检查</button>}
      </div>
    </section>
  </>, document.body);
}
