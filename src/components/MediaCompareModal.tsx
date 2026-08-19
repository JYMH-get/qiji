/**
 * MediaCompareModal —— 处理前后对比弹窗（全屏，滑杆分割：左=原素材、右=处理结果）。
 * 图像超分 / 视频超分 / 视频去字幕 结果节点「对比」共用：
 *  - 图像：两层 <img> 同比例像素对齐，顶层按分割线 clip-path 裁剪；
 *  - 视频：两路 <video> **同步播放**（统一播放/暂停/进度条；按结果侧时间轴对齐，漂移>0.15s 自动校正），
 *    同样滑杆分割对比。
 */
import { useEffect, useRef, useState } from "react";

export default function MediaCompareModal({ media, beforeUri, afterUri, beforeLabel = "原图", afterLabel = "超分", title, onClose }: {
    media: "image" | "video";
    beforeUri: string;
    afterUri: string;
    beforeLabel?: string;
    afterLabel?: string;
    title?: string;
    onClose: () => void;
}) {
    const [pos, setPos] = useState(50); // 分割线位置（%）
    const [beforeDim, setBeforeDim] = useState<{ w: number; h: number } | null>(null);
    const [afterDim, setAfterDim] = useState<{ w: number; h: number } | null>(null);
    const boxRef = useRef<HTMLDivElement>(null);
    const dragging = useRef(false);
    // 视频同步
    const beforeV = useRef<HTMLVideoElement>(null);
    const afterV = useRef<HTMLVideoElement>(null);
    const [playing, setPlaying] = useState(false);
    const [cur, setCur] = useState(0);
    const [dur, setDur] = useState(0);

    // ESC 关闭
    useEffect(() => {
        const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") onClose(); };
        window.addEventListener("keydown", onKey);
        return () => window.removeEventListener("keydown", onKey);
    }, [onClose]);

    const posFromEvent = (clientX: number) => {
        const r = boxRef.current?.getBoundingClientRect();
        if (!r || !r.width) return;
        setPos(Math.max(0, Math.min(100, ((clientX - r.left) / r.width) * 100)));
    };
    useEffect(() => {
        const move = (e: MouseEvent) => { if (dragging.current) posFromEvent(e.clientX); };
        const up = () => { dragging.current = false; };
        window.addEventListener("mousemove", move);
        window.addEventListener("mouseup", up);
        return () => { window.removeEventListener("mousemove", move); window.removeEventListener("mouseup", up); };
    }, []);

    // ── 视频：以「结果侧」为主时间轴，原视频跟随（漂移 >0.15s 校正）──
    const syncBefore = () => {
        const a = afterV.current, b = beforeV.current;
        if (!a || !b) return;
        if (Math.abs(b.currentTime - a.currentTime) > 0.15) b.currentTime = a.currentTime;
    };
    const togglePlay = () => {
        const a = afterV.current, b = beforeV.current;
        if (!a || !b) return;
        if (a.paused) {
            b.currentTime = a.currentTime;
            void a.play(); void b.play();
            setPlaying(true);
        } else {
            a.pause(); b.pause();
            setPlaying(false);
        }
    };
    const seekTo = (t: number) => {
        const a = afterV.current, b = beforeV.current;
        if (a) a.currentTime = t;
        if (b) b.currentTime = t;
        setCur(t);
    };
    const fmt = (t: number) => {
        const s = Math.max(0, Math.floor(t));
        return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
    };

    const dimText = (d: { w: number; h: number } | null) => (d ? `${d.w}×${d.h}` : "…");
    const badge: React.CSSProperties = { position: "absolute", top: 10, padding: "4px 12px", borderRadius: 6, fontSize: 12, color: "#fff", background: "rgba(0,0,0,0.6)", pointerEvents: "none", zIndex: 3 };
    const layer: React.CSSProperties = { position: "absolute", inset: 0, width: "100%", height: "100%", objectFit: "contain", pointerEvents: "none" };
    const ctlBtn: React.CSSProperties = { padding: "5px 16px", borderRadius: 6, fontSize: 12, cursor: "pointer", border: "1px solid rgba(255,255,255,0.14)", background: "rgba(255,255,255,0.06)", color: "#fff", whiteSpace: "nowrap" };

    return (
        <>
            <div onClick={onClose} style={{ position: "fixed", inset: 0, zIndex: 10500, background: "rgba(0,0,0,0.8)" }} />
            {/* 全屏面板 */}
            <div style={{ position: "fixed", inset: 14, zIndex: 10501, borderRadius: 12, background: "#12151f", border: "1px solid rgba(255,255,255,0.14)", boxShadow: "0 12px 40px rgba(0,0,0,0.6)", display: "flex", flexDirection: "column", gap: 10, padding: 14 }}>
                <div style={{ display: "flex", alignItems: "center", gap: 10, flexShrink: 0 }}>
                    <span style={{ fontSize: 14, fontWeight: 600, color: "#fff" }}>{title || "处理对比"}</span>
                    <span style={{ fontSize: 12, color: "rgba(255,255,255,0.5)" }}>
                        {beforeLabel} {dimText(beforeDim)} → {afterLabel} <span style={{ color: "#c4b5fd" }}>{dimText(afterDim)}</span>（拖动分割线对比）
                    </span>
                    <button onClick={onClose} style={{ ...ctlBtn, marginLeft: "auto" }}>关闭（Esc）</button>
                </div>

                {/* 对比区（占满剩余空间）：底层=处理结果；顶层=原素材按分割线 clip-path 裁剪。同比例两层像素对齐 */}
                <div
                    ref={boxRef}
                    onMouseDown={(e) => { e.preventDefault(); dragging.current = true; posFromEvent(e.clientX); }}
                    style={{ position: "relative", flex: 1, minHeight: 0, overflow: "hidden", borderRadius: 8, background: "#000", cursor: "ew-resize", userSelect: "none" }}
                >
                    {media === "image" ? (
                        <>
                            <img src={afterUri} alt={afterLabel} draggable={false} style={layer}
                                onLoad={(e) => { const im = e.currentTarget; setAfterDim({ w: im.naturalWidth, h: im.naturalHeight }); }} />
                            <img src={beforeUri} alt={beforeLabel} draggable={false} style={{ ...layer, clipPath: `inset(0 ${100 - pos}% 0 0)`, zIndex: 2 }}
                                onLoad={(e) => { const im = e.currentTarget; setBeforeDim({ w: im.naturalWidth, h: im.naturalHeight }); }} />
                        </>
                    ) : (
                        <>
                            <video ref={afterV} src={afterUri} muted playsInline loop style={layer}
                                onLoadedMetadata={(e) => { const v = e.currentTarget; setAfterDim({ w: v.videoWidth, h: v.videoHeight }); setDur(v.duration || 0); }}
                                onTimeUpdate={(e) => { setCur(e.currentTarget.currentTime); syncBefore(); }} />
                            <video ref={beforeV} src={beforeUri} muted playsInline loop style={{ ...layer, clipPath: `inset(0 ${100 - pos}% 0 0)`, zIndex: 2 }}
                                onLoadedMetadata={(e) => { const v = e.currentTarget; setBeforeDim({ w: v.videoWidth, h: v.videoHeight }); }} />
                        </>
                    )}
                    {/* 分割线 + 手柄 */}
                    <div style={{ position: "absolute", top: 0, bottom: 0, left: `${pos}%`, width: 2, background: "#8b5cf6", zIndex: 3, pointerEvents: "none", boxShadow: "0 0 8px rgba(139,92,246,0.8)" }} />
                    <div style={{ position: "absolute", top: "50%", left: `${pos}%`, transform: "translate(-50%,-50%)", width: 28, height: 28, borderRadius: 14, background: "#8b5cf6", color: "#fff", display: "flex", alignItems: "center", justifyContent: "center", fontSize: 13, zIndex: 3, pointerEvents: "none", boxShadow: "0 2px 8px rgba(0,0,0,0.5)" }}>⇄</div>
                    <span style={{ ...badge, left: 10 }}>{beforeLabel} {dimText(beforeDim)}</span>
                    <span style={{ ...badge, right: 10 }}>{afterLabel} {dimText(afterDim)}</span>
                </div>

                {/* 视频：同步播放控制条 */}
                {media === "video" && (
                    <div style={{ display: "flex", alignItems: "center", gap: 10, flexShrink: 0 }}>
                        <button onClick={togglePlay} style={ctlBtn}>{playing ? "⏸ 暂停" : "▶ 同步播放"}</button>
                        <span style={{ fontSize: 11, color: "rgba(255,255,255,0.55)", fontVariantNumeric: "tabular-nums", flexShrink: 0 }}>{fmt(cur)} / {fmt(dur)}</span>
                        <input
                            type="range"
                            min={0}
                            max={dur || 0}
                            step={0.05}
                            value={Math.min(cur, dur || 0)}
                            onChange={(e) => seekTo(Number(e.target.value) || 0)}
                            style={{ flex: 1, accentColor: "#8b5cf6", cursor: "pointer" }}
                        />
                        <span style={{ fontSize: 11, color: "rgba(255,255,255,0.4)", flexShrink: 0 }}>双路静音同步播放，拖动进度条两侧同跳</span>
                    </div>
                )}
            </div>
        </>
    );
}
