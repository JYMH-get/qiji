/**
 * Lightbox —— 全局放大灯箱（在 App 根挂一次）。任意界面调用 openLightbox({uri,name,media}) 即弹出。
 * 底部信息栏：资产名 + 分辨率（图片读 naturalWidth/Height；视频读 videoWidth/Height）。点遮罩关闭。
 * 滚轮缩放（以光标为锚点，1x~8x；图片/视频均可）；放大后可拖拽平移、双击复位；缩回 1x 自动回正。
 */
import { useEffect, useRef, useState } from "react";
import { useLightboxStore } from "@/store/lightboxStore";
import { saveUriToLocal } from "@/lib/saveMedia";
import { annotateUri } from "@/canvas/annotate";
import { depthifyUri } from "@/canvas/depthify";
import { depthifyVideoUri } from "@/canvas/videoDepthify";
import { viewAngleUri } from "@/canvas/viewAngleOp";

const MIN_Z = 1;
const MAX_Z = 8;

export default function Lightbox() {
    const item = useLightboxStore((s) => s.item);
    const close = useLightboxStore((s) => s.close);
    const [dims, setDims] = useState<{ w: number; h: number } | null>(null);
    const [menu, setMenu] = useState<{ x: number; y: number } | null>(null); // 右击「保存到本地」菜单
    // 滚轮缩放视图态：z=倍率，x/y=平移（像素，作用在媒体元素 transform 上）
    const [view, setView] = useState({ z: 1, x: 0, y: 0 });
    const boxRef = useRef<HTMLDivElement>(null); // 媒体容器（滚轮监听 + 缩放锚点基准）
    const movedRef = useRef(false); // 本次按下是否发生了拖拽平移（防拖完松手误触发单击关闭）

    // 切换条目时清空旧分辨率/菜单/缩放视图；ESC 关闭
    useEffect(() => {
        setDims(null);
        setMenu(null);
        setView({ z: 1, x: 0, y: 0 });
        if (!item) return;
        const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") close(); };
        window.addEventListener("keydown", onKey);
        return () => window.removeEventListener("keydown", onKey);
    }, [item, close]);

    // 滚轮缩放：native 非 passive 监听（React onWheel 在根节点是 passive，preventDefault 无效）；
    // 以光标为锚点——光标压着的内容点缩放前后保持在原屏幕位置；缩回 1x 自动回正。
    useEffect(() => {
        const el = boxRef.current;
        if (!el || !item) return;
        const onWheel = (e: WheelEvent) => {
            e.preventDefault();
            e.stopPropagation();
            const rect = el.getBoundingClientRect();
            const cx = rect.x + rect.width / 2;
            const cy = rect.y + rect.height / 2;
            setView((v) => {
                const z = Math.min(MAX_Z, Math.max(MIN_Z, v.z * Math.exp(-e.deltaY * 0.0018)));
                if (z === v.z) return v;
                if (z <= MIN_Z + 1e-6) return { z: 1, x: 0, y: 0 };
                const k = z / v.z;
                return {
                    z,
                    x: e.clientX - cx - (e.clientX - cx - v.x) * k,
                    y: e.clientY - cy - (e.clientY - cy - v.y) * k,
                };
            });
        };
        el.addEventListener("wheel", onWheel, { passive: false });
        return () => el.removeEventListener("wheel", onWheel);
    }, [item]);

    if (!item) return null;
    const media = item.media || "image";
    const zoomed = view.z > 1;

    // 放大后拖拽平移（图片/视频通用；发生位移则标记，松手后的 click 不再关闭灯箱）
    const startPan = (e: React.MouseEvent) => {
        movedRef.current = false;
        if (!zoomed || e.button !== 0) return;
        e.preventDefault();
        e.stopPropagation();
        const start = { sx: e.clientX, sy: e.clientY, ox: view.x, oy: view.y };
        const onMove = (me: MouseEvent) => {
            const dx = me.clientX - start.sx;
            const dy = me.clientY - start.sy;
            if (Math.abs(dx) + Math.abs(dy) > 4) movedRef.current = true;
            setView((v) => ({ ...v, x: start.ox + dx, y: start.oy + dy }));
        };
        const onUp = () => {
            window.removeEventListener("mousemove", onMove);
            window.removeEventListener("mouseup", onUp);
        };
        window.addEventListener("mousemove", onMove);
        window.addEventListener("mouseup", onUp);
    };
    const resetView = () => setView({ z: 1, x: 0, y: 0 });
    const mediaTransform = zoomed
        ? { transform: `translate(${view.x}px, ${view.y}px) scale(${view.z})`, transformOrigin: "center center" as const }
        : undefined;

    // 右击媒体：弹「保存到本地」菜单（拦截原生菜单，统一各界面的全屏放大保存）
    const onMediaContextMenu = (e: React.MouseEvent) => {
        e.preventDefault();
        e.stopPropagation();
        setMenu({ x: e.clientX, y: e.clientY });
    };
    const doSave = () => {
        setMenu(null);
        const label = media === "video" ? "视频" : media === "audio" ? "音频" : "图片";
        saveUriToLocal(item.uri, item.name || label, media).catch((err) =>
            alert(`保存失败：${err instanceof Error ? err.message : "未知错误"}`),
        );
    };

    return (
        <div onClick={close} style={{ position: "fixed", inset: 0, zIndex: 100200, background: "rgba(0,0,0,0.82)", display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center", cursor: "zoom-out" }}>
            <div ref={boxRef} style={{ flex: 1, minHeight: 0, display: "flex", alignItems: "center", justifyContent: "center", width: "100%", padding: "32px 32px 8px", overflow: "hidden" }}>
                {media === "video" ? (
                    <video src={item.uri} controls autoPlay onClick={(e) => e.stopPropagation()} onContextMenu={onMediaContextMenu}
                        onMouseDown={startPan} onDoubleClick={(e) => { e.stopPropagation(); if (zoomed) resetView(); }}
                        title="滚轮缩放 / 右击保存到本地"
                        onLoadedMetadata={(e) => setDims({ w: e.currentTarget.videoWidth, h: e.currentTarget.videoHeight })}
                        style={{ maxWidth: "92vw", maxHeight: "84vh", borderRadius: 8, ...mediaTransform, cursor: zoomed ? "grab" : undefined }} />
                ) : media === "audio" ? (
                    <audio src={item.uri} controls autoPlay onClick={(e) => e.stopPropagation()} onContextMenu={onMediaContextMenu} title="右击保存到本地" style={{ width: "min(80vw, 480px)" }} />
                ) : (
                    // 1x 时单击图片退出预览；放大后单击不关（拖拽平移中），双击复位到 1x；右击保存到本地
                    <img src={item.uri} alt={item.name || "放大"} draggable={false}
                        onClick={(e) => { e.stopPropagation(); if (!zoomed && !movedRef.current) close(); }}
                        onMouseDown={startPan} onDoubleClick={(e) => { e.stopPropagation(); if (zoomed) resetView(); }}
                        onContextMenu={onMediaContextMenu} title={zoomed ? "滚轮缩放 / 拖拽平移 / 双击复位" : "滚轮缩放 / 单击退出预览 / 右击保存到本地"}
                        onLoad={(e) => setDims({ w: e.currentTarget.naturalWidth, h: e.currentTarget.naturalHeight })}
                        style={{ maxWidth: "92vw", maxHeight: "84vh", borderRadius: 8, objectFit: "contain", ...mediaTransform, cursor: zoomed ? "grab" : "zoom-out" }} />
                )}
            </div>
            {/* 底部信息栏：资产名 + 分辨率 + 缩放倍率 */}
            <div onClick={(e) => e.stopPropagation()} style={{ flexShrink: 0, display: "flex", alignItems: "center", gap: 14, padding: "10px 18px 22px", color: "rgba(255,255,255,0.9)", fontSize: 13, cursor: "default", maxWidth: "92vw" }}>
                <span style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", maxWidth: "60vw" }}>{item.name || "未命名"}</span>
                {dims && (
                    <span style={{ fontFamily: "monospace", color: "rgba(255,255,255,0.7)", background: "rgba(255,255,255,0.08)", border: "1px solid rgba(255,255,255,0.14)", borderRadius: 5, padding: "2px 8px" }}>
                        {dims.w}×{dims.h}
                    </span>
                )}
                {zoomed && (
                    <span onClick={resetView} title="点击复位到 1x"
                        style={{ fontFamily: "monospace", color: "#a5f3fc", background: "rgba(34,211,238,0.12)", border: "1px solid rgba(34,211,238,0.35)", borderRadius: 5, padding: "2px 8px", cursor: "pointer" }}>
                        {Math.round(view.z * 100)}%
                    </span>
                )}
                {/* 图片 → 涂鸦（标注编辑器）：关灯箱进全屏编辑器（产物新建画布图片节点承载） */}
                {media === "image" && (
                    <>
                        <span onClick={() => { close(); annotateUri(item.uri, item.name); }} title="进入涂鸦编辑：笔/箭头/图形/文字，完成后合成图落为画布图片节点"
                            style={{ color: "#c4b5fd", background: "rgba(139,92,246,0.14)", border: "1px solid rgba(139,92,246,0.4)", borderRadius: 5, padding: "2px 10px", cursor: "pointer", whiteSpace: "nowrap" }}>
                            ✎ 涂鸦
                        </span>
                        <span onClick={() => { close(); depthifyUri(item.uri, item.name); }} title="转深度：本地推理生成黑白深度图（近白远黑），完成后落为画布图片节点"
                            style={{ color: "#a5f3fc", background: "rgba(34,211,238,0.10)", border: "1px solid rgba(34,211,238,0.35)", borderRadius: 5, padding: "2px 10px", cursor: "pointer", whiteSpace: "nowrap" }}>
                            ◑ 转深度
                        </span>
                        <span onClick={() => { close(); viewAngleUri(item.uri, item.name); }} title="转视角：多角度编辑器选机位，图像编辑模型按新视角重拍，产物落为画布图片节点"
                            style={{ color: "#93c5fd", background: "rgba(59,130,246,0.10)", border: "1px solid rgba(59,130,246,0.35)", borderRadius: 5, padding: "2px 10px", cursor: "pointer", whiteSpace: "nowrap" }}>
                            ⟳ 转视角
                        </span>
                    </>
                )}
                {/* 视频 → 转深度：逐帧本地推理生成灰度深度视频，产物落为画布转深度节点（第206轮） */}
                {media === "video" && (
                    <span onClick={() => { close(); depthifyVideoUri(item.uri, item.name); }} title="转深度：按原帧率逐帧本地推理生成灰度深度视频（近白远黑），完成后落为画布转深度节点（耗时随视频时长）"
                        style={{ color: "#a5f3fc", background: "rgba(34,211,238,0.10)", border: "1px solid rgba(34,211,238,0.35)", borderRadius: 5, padding: "2px 10px", cursor: "pointer", whiteSpace: "nowrap" }}>
                        ◑ 转深度
                    </span>
                )}
                {/* 该资产绑定的音色（资产助手放大传入）：提示 + 直接可播 */}
                {item.voiceUri && (
                    <span style={{ display: "flex", alignItems: "center", gap: 8, background: "rgba(139,92,246,0.14)", border: "1px solid rgba(139,92,246,0.4)", borderRadius: 6, padding: "3px 10px" }}>
                        <span style={{ fontSize: 12, color: "#cbb8ff", whiteSpace: "nowrap" }}>已绑定音色·{item.voiceName || "声音参考"}</span>
                        <audio src={item.voiceUri} controls style={{ height: 24, width: 210 }} />
                    </span>
                )}
            </div>

            {/* 右击「保存到本地」菜单（点外/再右击/ESC 关闭，点项不关灯箱）*/}
            {menu && (
                <>
                    <div onClick={(e) => { e.stopPropagation(); setMenu(null); }} onContextMenu={(e) => { e.preventDefault(); e.stopPropagation(); setMenu(null); }} style={{ position: "fixed", inset: 0, zIndex: 100210 }} />
                    <div onClick={(e) => e.stopPropagation()} style={{ position: "fixed", zIndex: 100211, top: Math.min(menu.y, window.innerHeight - 56), left: Math.min(menu.x, window.innerWidth - 160), minWidth: 140, padding: 6, borderRadius: 8, border: "1px solid rgba(255,255,255,0.14)", background: "#161b26", boxShadow: "0 8px 24px rgba(0,0,0,0.55)" }}>
                        <div onClick={doSave} style={{ padding: "8px 12px", borderRadius: 6, fontSize: 13, color: "#fff", cursor: "pointer" }}
                            onMouseEnter={(e) => (e.currentTarget.style.background = "rgba(139,92,246,0.25)")}
                            onMouseLeave={(e) => (e.currentTarget.style.background = "transparent")}>保存到本地</div>
                    </div>
                </>
            )}
        </div>
    );
}
