/**
 * ClipPickerModal —— 视频片段选择弹窗（播放器 + 起始/结束时间），确认后由调用方裁剪。
 * 资产模式（添加视频片段到下一镜）与画布模式（视频节点右键「分段」）共用。
 */
import { useState } from "react";
import { useDisplayUri } from "@/nodes/ResultView";

const fld: React.CSSProperties = { flex: 1, minWidth: 0, background: "rgba(255,255,255,0.05)", border: "1px solid rgba(255,255,255,0.12)", borderRadius: 6, color: "#fff", padding: "5px 8px", fontSize: 12, outline: "none" };
const miniBtn: React.CSSProperties = { whiteSpace: "nowrap", padding: "5px 8px", borderRadius: 6, fontSize: 11, cursor: "pointer", border: "1px solid rgba(255,255,255,0.14)", background: "rgba(255,255,255,0.06)", color: "#fff" };
const ghost: React.CSSProperties = { padding: "7px 14px", borderRadius: 8, fontSize: 12, cursor: "pointer", border: "1px solid rgba(255,255,255,0.14)", background: "rgba(255,255,255,0.05)", color: "#fff" };
const primary: React.CSSProperties = { padding: "7px 14px", borderRadius: 8, fontSize: 12, fontWeight: 600, cursor: "pointer", border: "none", background: "linear-gradient(90deg,#8b5cf6,#7c3aed)", color: "#fff" };

export default function ClipPickerModal({ uri, title, confirmText, hint, onCancel, onConfirm }: {
    uri: string;
    /** 弹窗标题（如「选择视频片段（添加到下一镜）」） */
    title: string;
    /** 确认按钮文案（如「提取并添加到下一镜」） */
    confirmText: string;
    /** 底部说明行（可选） */
    hint?: string;
    onCancel: () => void;
    onConfirm: (start: number, end: number) => void;
}) {
    // 预览用本地优先 uri（远程 https(OSS) 在 Tauri 下先落本地副本再显示，避免延迟/卡顿/过期）；
    // 裁剪由调用方对节点资产做（captureFromUri 本就优先 localPath），结果上传 OSS。
    const displayUri = useDisplayUri(uri);
    const [dur, setDur] = useState(0);
    const [start, setStart] = useState(0);
    const [end, setEnd] = useState(0);
    const [cur, setCur] = useState(0);
    const fmt = (t: number) => `${(t || 0).toFixed(1)}s`;
    const clamp = (t: number) => Math.max(0, Math.min(t, dur || 0));
    const valid = end > start;
    return (
        <>
            <div onClick={onCancel} style={{ position: "fixed", inset: 0, zIndex: 10500, background: "rgba(0,0,0,0.55)" }} />
            <div style={{ position: "fixed", zIndex: 10501, top: "50%", left: "50%", transform: "translate(-50%,-50%)", width: 520, maxWidth: "92vw", maxHeight: "90vh", overflowY: "auto", padding: 18, borderRadius: 12, background: "#161b26", border: "1px solid rgba(255,255,255,0.14)", boxShadow: "0 12px 40px rgba(0,0,0,0.6)", display: "flex", flexDirection: "column", gap: 12 }}>
                <div style={{ fontSize: 14, fontWeight: 600, color: "#fff" }}>{title}</div>
                <video src={displayUri} controls
                    onLoadedMetadata={(e) => { const d = e.currentTarget.duration || 0; setDur(d); setEnd(d); }}
                    onTimeUpdate={(e) => setCur(e.currentTarget.currentTime)}
                    style={{ width: "100%", maxHeight: 280, borderRadius: 8, background: "#000" }} />
                <div style={{ fontSize: 12, color: "rgba(255,255,255,0.6)" }}>播放位置 {fmt(cur)} ／ 总时长 {fmt(dur)}（播放到目标位置后点「设为当前」）</div>
                <div style={{ display: "flex", gap: 12 }}>
                    <label style={{ flex: 1, display: "flex", flexDirection: "column", gap: 4, fontSize: 11, color: "rgba(255,255,255,0.6)" }}>
                        起始时间(秒)
                        <div style={{ display: "flex", gap: 6 }}>
                            <input type="number" min={0} max={dur || undefined} step={0.1} value={start} onChange={(e) => setStart(clamp(Number(e.target.value) || 0))} style={fld} />
                            <button style={miniBtn} onClick={() => setStart(clamp(cur))}>设为当前</button>
                        </div>
                    </label>
                    <label style={{ flex: 1, display: "flex", flexDirection: "column", gap: 4, fontSize: 11, color: "rgba(255,255,255,0.6)" }}>
                        结束时间(秒)
                        <div style={{ display: "flex", gap: 6 }}>
                            <input type="number" min={0} max={dur || undefined} step={0.1} value={end} onChange={(e) => setEnd(clamp(Number(e.target.value) || 0))} style={fld} />
                            <button style={miniBtn} onClick={() => setEnd(clamp(cur))}>设为当前</button>
                        </div>
                    </label>
                </div>
                <div style={{ fontSize: 12, color: valid ? "#c4b5fd" : "#f87171" }}>片段时长：{valid ? fmt(end - start) : "无效（结束须晚于起始）"}</div>
                {hint && <div style={{ fontSize: 11, color: "rgba(255,255,255,0.4)", lineHeight: 1.5 }}>{hint}</div>}
                <div style={{ display: "flex", justifyContent: "flex-end", gap: 8 }}>
                    <button style={ghost} onClick={onCancel}>取消</button>
                    <button style={{ ...primary, opacity: valid ? 1 : 0.5, cursor: valid ? "pointer" : "not-allowed" }} disabled={!valid} onClick={() => onConfirm(start, end)}>{confirmText}</button>
                </div>
            </div>
        </>
    );
}
