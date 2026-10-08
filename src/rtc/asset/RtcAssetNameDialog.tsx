import { useEffect, useId, useRef, useState } from "react";
import { createPortal } from "react-dom";

export function RtcAssetNameDialog({ title, initialValue, onSubmit, onClose }: {
  title: string; initialValue: string; onSubmit: (name: string) => void; onClose: () => void;
}) {
  const [name, setName] = useState(initialValue);
  const input = useRef<HTMLInputElement>(null);
  const submitted = useRef(false);
  const titleId = useId();
  useEffect(() => {
    const previous = document.activeElement as HTMLElement | null;
    input.current?.focus();
    input.current?.select();
    return () => { if (previous?.isConnected) previous.focus(); };
  }, []);
  return createPortal(<div onMouseDown={onClose}
    style={{ position: "fixed", inset: 0, zIndex: 100400, background: "rgba(4,6,12,0.6)", display: "flex", alignItems: "center", justifyContent: "center" }}>
    <form role="dialog" aria-modal="true" aria-labelledby={titleId} onMouseDown={event => event.stopPropagation()}
      onKeyDown={event => {
        event.stopPropagation();
        if (event.key === "Escape") { event.preventDefault(); onClose(); }
        if (event.key === "Tab") {
          const items = Array.from(event.currentTarget.querySelectorAll<HTMLElement>("input, button:not(:disabled)"));
          const next = event.shiftKey ? items[items.length - 1] : items[0];
          if (document.activeElement === (event.shiftKey ? items[0] : items[items.length - 1])) { event.preventDefault(); next?.focus(); }
        }
      }}
      onSubmit={event => { event.preventDefault(); if (name.trim() && !submitted.current) { submitted.current = true; onSubmit(name.trim()); } }}
      style={{ width: 340, maxWidth: "calc(100vw - 48px)", padding: 18, borderRadius: 12, border: "1px solid rgba(255,255,255,0.14)", background: "#161820", color: "#fff", boxShadow: "0 22px 70px rgba(0,0,0,0.6)" }}>
      <div id={titleId} style={{ fontSize: 14, fontWeight: 600, marginBottom: 14 }}>{title}</div>
      <input ref={input} aria-label="名称" value={name} onChange={event => setName(event.target.value)}
        style={{ boxSizing: "border-box", width: "100%", padding: "8px 10px", borderRadius: 6, border: "1px solid rgba(255,255,255,0.18)", background: "#22242d", color: "#fff" }} />
      <div style={{ display: "flex", justifyContent: "flex-end", gap: 8, marginTop: 16 }}>
        <button type="button" onClick={onClose} style={{ padding: "6px 16px", borderRadius: 6, background: "#282a34", color: "#fff" }}>取消</button>
        <button type="submit" disabled={!name.trim()} style={{ padding: "6px 16px", borderRadius: 6, background: "#8b5cf6", color: "#fff", opacity: name.trim() ? 1 : 0.5 }}>创建</button>
      </div>
    </form>
  </div>, document.body);
}
