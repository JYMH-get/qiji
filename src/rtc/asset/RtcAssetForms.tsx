import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { useProjectStore, type AssetCat } from "@/store/projectStore";
import { useAssetFormStore } from "@/store/assetFormStore";
import { AssetDisplayImage } from "@/components/AssetDisplayImage";
import { useScopedLightboxGallery } from "@/hooks/useScopedLightboxGallery";
import { collectAssetForms } from "./rtcAssetData";
import { confirmDialog } from "@/lib/confirmDialog";
import { genId } from "@/lib/id";
import { useRtcCenterTabStore } from "../panel/rtcCenterTabStore";
import { useRtcPropsTabStore } from "../panel/rtcPropsTabStore";
import { RtcAssetNameDialog } from "./RtcAssetNameDialog";

/** 预览左缘的造型栏：未出图变体也可选中并在右侧生成。 */
export function RtcAssetForms({ cat, id }: { cat: AssetCat; id: string }) {
  const owner = useProjectStore(state => state.projectInstanceId);
  const asset = useProjectStore(state => state[cat].find(item => item.id === id));
  const selected = useAssetFormStore(state => state.selForm[id]);
  const scope = JSON.stringify([owner, cat, id]);
  const liveScope = useRef(scope);
  liveScope.current = scope;
  const mounted = useRef(true);
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; }; }, []);
  const [nameDialog, setNameDialog] = useState<{ scope: string; token: object } | null>(null);
  const nameToken = useRef<object | null>(null);
  const [menu, setMenu] = useState<{ scope: string; x: number; y: number; variantId: string | null; label: string } | null>(null);
  const current = () => {
    const state = useProjectStore.getState();
    return mounted.current && liveScope.current === scope && state.projectInstanceId === owner && !state.isProjectLoading
      ? state[cat].find(item => item.id === id) : undefined;
  };
  const addForm = (name: string) => {
    const target = current(), label = name.trim();
    if (!target || !label || !nameDialog || nameDialog.scope !== scope || nameToken.current !== nameDialog.token) return;
    nameToken.current = null;
    setNameDialog(null);
    const variantId = genId("v");
    useProjectStore.getState().addAssetVariant(cat, id, {
      id: variantId, label, name: target.name, description: "", prompt: target.prompt || "", images: [],
    });
    useAssetFormStore.getState().setSelForm(id, variantId);
    useRtcCenterTabStore.getState().setTab("preview");
    useRtcPropsTabStore.getState().setTab("props");
    void useProjectStore.getState().save(true);
  };
  const deleteForm = async (variantId: string | null) => {
    setMenu(null);
    if (!variantId) return;
    const form = current()?.variants?.find(variant => variant.id === variantId);
    if (!form || !await confirmDialog(`删除分体「${form.label || "造型"}」及其历史图片？`)) return;
    if (!current()?.variants?.some(variant => variant.id === variantId)) return;
    useProjectStore.getState().removeAssetVariant(cat, id, variantId);
    if (useAssetFormStore.getState().selForm[id] === variantId) useAssetFormStore.getState().setSelForm(id, null);
    void useProjectStore.getState().save(true);
  };
  const open = useScopedLightboxGallery(`${owner}/${cat}/${id}/rtc-forms`, {
    getItems: () => {
      const target = current();
      return target ? collectAssetForms(target).map(form => ({ id: form.variantId ?? "base", uri: form.uri, name: form.name, media: "image" as const })) : null;
    },
    subscribe: listener => useProjectStore.subscribe(listener),
  });
  if (!asset) return null;
  const forms = [
    { variantId: null, label: "基础形象", uri: asset.image },
    ...(asset.variants ?? []).map(variant => ({ variantId: variant.id, label: variant.label || "造型", uri: variant.image })),
  ];
  const active = forms.find(form => form.variantId === selected)?.variantId ?? null;
  return <nav aria-label="分体选择" style={{ width: 124, flexShrink: 0, minHeight: 0, overflowY: "auto", padding: "12px 8px", borderRight: "1px solid rgba(255,255,255,0.08)" }}>
    <div style={{ color: "rgba(255,255,255,0.55)", fontSize: 11, marginBottom: 10 }}>分体选择（{forms.length}）</div>
    <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
      {forms.map(form => <button key={form.variantId ?? "base"} type="button" aria-pressed={active === form.variantId}
        title={`${form.label}${form.uri ? " · 双击放大" : " · 未出图"}`}
        onClick={() => { if (current() && (!form.variantId || current()?.variants?.some(variant => variant.id === form.variantId))) useAssetFormStore.getState().setSelForm(id, form.variantId); }}
        onDoubleClick={() => { if (form.uri) open(form.variantId ?? "base"); }}
        onContextMenu={event => {
          event.preventDefault(); event.stopPropagation();
          if (!current() || form.variantId && !current()?.variants?.some(variant => variant.id === form.variantId)) return;
          useAssetFormStore.getState().setSelForm(id, form.variantId);
          setMenu({ scope, x: Math.max(8, Math.min(event.clientX, window.innerWidth - 178)), y: Math.max(8, Math.min(event.clientY, window.innerHeight - 54)), variantId: form.variantId, label: form.label });
        }}
        style={{ position: "relative", width: "100%", padding: 0, borderRadius: 6, overflow: "hidden", cursor: "pointer", border: active === form.variantId ? "2px solid #a78bfa" : "2px solid transparent", color: "#fff", background: "rgba(139,92,246,0.08)" }}>
        <div style={{ aspectRatio: "1", display: "flex", alignItems: "center", justifyContent: "center" }}>
          {form.uri ? <AssetDisplayImage uri={form.uri} alt={form.label} draggable={false} style={{ width: "100%", height: "100%", objectFit: "cover" }} />
            : <span style={{ color: "rgba(255,255,255,0.4)", fontSize: 11 }}>未出图</span>}
        </div>
        <div style={{ padding: "4px 3px", fontSize: 11, overflowWrap: "anywhere", background: "rgba(0,0,0,0.35)" }}>{form.label}</div>
      </button>)}
      <button type="button" title="新增分体" aria-label="新增分体" onClick={() => {
        if (!current()) return;
        const token = {};
        nameToken.current = token;
        setMenu(null); setNameDialog({ scope, token });
      }} style={{ width: "100%", aspectRatio: "1", flexShrink: 0, border: "1px dashed rgba(167,139,250,0.5)", borderRadius: 6, background: "rgba(139,92,246,0.05)", color: "#a78bfa", fontSize: 30, cursor: "pointer" }}>+</button>
    </div>
    {nameDialog?.scope === scope && <RtcAssetNameDialog title="新增分体" initialValue="新造型" onSubmit={addForm} onClose={() => {
      if (nameToken.current === nameDialog.token) { nameToken.current = null; setNameDialog(null); }
    }} />}
    {menu?.scope === scope && createPortal(<div onPointerDown={() => setMenu(null)} onContextMenu={event => { event.preventDefault(); setMenu(null); }}
      onKeyDown={event => { event.stopPropagation(); if (event.key === "Escape") setMenu(null); }}
      style={{ position: "fixed", inset: 0, zIndex: 11000 }}>
      <div role="menu" aria-label={`${menu.label}操作`} onPointerDown={event => event.stopPropagation()} style={{ position: "absolute", left: menu.x, top: menu.y, minWidth: 162, padding: 5, borderRadius: 7, border: "1px solid rgba(255,255,255,0.16)", background: "#191c25", boxShadow: "0 8px 28px #0007" }}>
        <button type="button" role="menuitem" autoFocus disabled={!menu.variantId} onClick={() => void deleteForm(menu.variantId)}
          style={{ width: "100%", border: 0, borderRadius: 4, padding: "7px 9px", textAlign: "left", fontSize: 12, color: menu.variantId ? "#fca5a5" : "#8a8b91", background: "transparent", cursor: menu.variantId ? "pointer" : "default" }}>
          {menu.variantId ? "删除分体" : "基础形象不可删除"}
        </button>
      </div>
    </div>, document.body)}
  </nav>;
}
