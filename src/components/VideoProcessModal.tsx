/**
 * VideoProcessModal —— 视频处理弹窗（超分/去字幕，火山引擎 MediaKit）。
 * 资产模式（视频区右击菜单）与画布模式（视频节点悬停工具栏）共用。
 *
 * 内容：源视频预览 + 处理模型（超分=capability "video-enhance" 的 4 种版本；去字幕="video-erase"；
 * **无占位项**——未选过时自动选中第一个可用模型，直接显示模型与参数）+ 所选模型的动态参数
 * （catalog model.params：enum→下拉 / number→数字框；enum 值经 OPTION_LABELS 中文化显示，提交仍发原值）。
 * 去字幕额外提供「擦除范围」：全屏（默认，走上游自动检测策略）/ 局部——在预览画面上**拖拽画框**
 * 限定擦除区域（≤20 个，坐标为 [0,1] 比例，发 erase_ratio_location）。
 * 模型选择随项目持久化（projectModelConfig，经 ModelPicker）；确认回传 {modelKey, modelLabel, params}，
 * 提交/落地由调用方负责（资产模式走 generationQueue.startDerivedGeneration，画布走节点运行）。
 */
import { useEffect, useMemo, useRef, useState } from "react";
import type { Capability, ParamField } from "@/contract";
import { useDisplayUri } from "@/nodes/ResultView";
import { useCatalogStore } from "@/store/catalogStore";
import { useProjectStore } from "@/store/projectStore";
import ModelPicker from "@/components/ModelPicker";

export type VideoProcessMode = "upscale" | "desub" | "imageUpscale";

export interface VideoProcessSpec {
    modelKey: string;
    modelLabel: string;
    params: Record<string, unknown>;
}

const fld: React.CSSProperties = { flex: 1, minWidth: 0, background: "rgba(255,255,255,0.05)", border: "1px solid rgba(255,255,255,0.12)", borderRadius: 6, color: "#fff", padding: "5px 8px", fontSize: 12, outline: "none" };
const ghost: React.CSSProperties = { padding: "7px 14px", borderRadius: 8, fontSize: 12, cursor: "pointer", border: "1px solid rgba(255,255,255,0.14)", background: "rgba(255,255,255,0.05)", color: "#fff" };
const primary: React.CSSProperties = { padding: "7px 14px", borderRadius: 8, fontSize: 12, fontWeight: 600, cursor: "pointer", border: "none", background: "linear-gradient(90deg,#8b5cf6,#7c3aed)", color: "#fff" };
const optBg: React.CSSProperties = { background: "#1f1f2e" };
const segBtn = (on: boolean): React.CSSProperties => ({
    padding: "4px 12px", borderRadius: 6, fontSize: 12, cursor: "pointer",
    border: on ? "1px solid #8b5cf6" : "1px solid rgba(255,255,255,0.14)",
    background: on ? "rgba(139,92,246,0.22)" : "rgba(255,255,255,0.05)", color: "#fff",
});

/** 模式 → 模型能力（超分 4 版本 / 去字幕 1 版本 / 图像超分 1 版本都是该能力下的模型） */
export const PROCESS_CAP: Record<VideoProcessMode, Capability> = { upscale: "video-enhance", desub: "video-erase", imageUpscale: "image-enhance" };
/** 模式 → 用途 */
export const PROCESS_PURPOSE = { upscale: "video.upscale", desub: "video.desub", imageUpscale: "image.upscale" } as const;

/** enum 参数值的中文显示（提交仍发原值）：按参数 key 分组。处理节点只读面板（VideoOperationPanel）共用 */
const OPTION_LABELS: Record<string, Record<string, string>> = {
    mode: { Subtitle: "字幕", Text: "文字" },
    scene: { common: "通用", ugc: "UGC", short_series: "短剧", aigc: "AIGC", old_film: "老片修复" },
    tool_version: { standard: "标准", professional: "专业", max: "极致" },
};
export const optLabel = (key: string, v: string) => OPTION_LABELS[key]?.[v] ?? v;

function defaultsOf(fields: ParamField[]): Record<string, unknown> {
    const out: Record<string, unknown> = {};
    for (const f of fields) {
        if (f.default === undefined) continue;
        out[f.key] = typeof f.default === "number" ? f.default : String(f.default);
    }
    return out;
}

/** 局部擦除框（[0,1] 比例坐标，x1<x2 / y1<y2） */
interface RatioBox { x1: number; y1: number; x2: number; y2: number }

export default function VideoProcessModal({ uri, mode, sourceName, onCancel, onConfirm }: {
    /** 源视频（预览用，本地 uri 即可） */
    uri: string;
    mode: VideoProcessMode;
    /** 源名称（标题展示，可选） */
    sourceName?: string;
    onCancel: () => void;
    onConfirm: (spec: VideoProcessSpec) => void;
}) {
    // 预览用本地优先 uri：远程 https(OSS) 在 Tauri 下先下本地副本再显示（避免延迟/卡顿/过期）；
    // 提交仍走原资产 → ensurePublicUrl(OSS)，与预览解耦。
    const displayUri = useDisplayUri(uri);
    const isUp = mode === "upscale";
    const isImage = mode === "imageUpscale";
    const isDesub = mode === "desub";
    const cap = PROCESS_CAP[mode];
    const modeTitle = isImage ? "图像超分（画质增强）" : isUp ? "视频超分（画质增强）" : "视频去字幕";
    const models = useCatalogStore((s) => s.catalog?.models);
    // 模型选择走项目级持久化（ModelPicker 写 projectModelConfig[cap]）；新能力无设置面板默认，值即 override
    const modelKey = useProjectStore((s) => s.projectModelConfig?.[cap]) || "";
    const capModels = useMemo(() => (models ?? []).filter((m) => m.capability === cap), [models, cap]);
    const model = useMemo(() => capModels.find((m) => m.id === modelKey) || null, [capModels, modelKey]);

    // 无占位：未选过/失效 → 自动选中第一个可用模型（写回项目级配置，下次直接生效）
    useEffect(() => {
        if (!model && capModels.length) useProjectStore.getState().setProjectModelConfig({ [cap]: capModels[0].id });
    }, [model, capModels, cap]);

    // 参数：切换模型时重置为该模型默认值
    const [params, setParams] = useState<Record<string, unknown>>({});
    useEffect(() => { setParams(defaultsOf(model?.params ?? [])); }, [model?.id]); // eslint-disable-line react-hooks/exhaustive-deps
    const setP = (key: string, v: unknown) => setParams((p) => ({ ...p, [key]: v }));

    // ── 图像超分「目标」：倍率（1/1.5/2/4）或 长边分辨率（2k=2048 / 4k=3840，短边按比例）——
    //    统一换算成上游 multiple；无论哪种，输出**单边不超过 6000**（超出自动夹紧）。计算见下方 imgPlan（依赖源图尺寸）。
    const [imgTarget, setImgTarget] = useState<string>("2");
    // ── 去字幕「擦除范围」：全屏（默认）/ 局部画框 ──
    const [region, setRegion] = useState<"full" | "partial">("full");
    const [boxes, setBoxes] = useState<RatioBox[]>([]);
    const [draft, setDraft] = useState<RatioBox | null>(null);
    const videoRef = useRef<HTMLVideoElement>(null);
    const wrapRef = useRef<HTMLDivElement>(null);
    // 视频内容区（object-fit:contain 有黑边时，画框坐标须相对内容而非元素）：按元素盒 + 原生宽高算
    const [vDim, setVDim] = useState<{ w: number; h: number } | null>(null);
    const [wrapSize, setWrapSize] = useState<{ w: number; h: number } | null>(null);
    useEffect(() => {
        const el = wrapRef.current;
        if (!el || typeof ResizeObserver === "undefined") return;
        const ro = new ResizeObserver(() => setWrapSize({ w: el.clientWidth, h: el.clientHeight }));
        ro.observe(el);
        setWrapSize({ w: el.clientWidth, h: el.clientHeight });
        return () => ro.disconnect();
    }, []);
    /** 内容区（px，相对 wrap 左上）：无元数据时退化为整个元素盒 */
    const content = useMemo(() => {
        const ew = wrapSize?.w ?? 0, eh = wrapSize?.h ?? 0;
        if (!ew || !eh) return null;
        if (!vDim) return { x: 0, y: 0, w: ew, h: eh };
        const scale = Math.min(ew / vDim.w, eh / vDim.h);
        const w = vDim.w * scale, h = vDim.h * scale;
        return { x: (ew - w) / 2, y: (eh - h) / 2, w, h };
    }, [wrapSize, vDim]);

    const clamp01 = (n: number) => Math.max(0, Math.min(1, n));
    const toRatio = (clientX: number, clientY: number): { x: number; y: number } | null => {
        const el = wrapRef.current;
        if (!el || !content) return null;
        const r = el.getBoundingClientRect();
        return {
            x: clamp01((clientX - r.left - content.x) / content.w),
            y: clamp01((clientY - r.top - content.y) / content.h),
        };
    };
    const dragStart = useRef<{ x: number; y: number } | null>(null);
    const onDrawDown = (e: React.MouseEvent) => {
        e.preventDefault();
        const p = toRatio(e.clientX, e.clientY);
        if (p) { dragStart.current = p; setDraft({ x1: p.x, y1: p.y, x2: p.x, y2: p.y }); }
    };
    const onDrawMove = (e: React.MouseEvent) => {
        const s = dragStart.current;
        if (!s) return;
        const p = toRatio(e.clientX, e.clientY);
        if (p) setDraft({ x1: Math.min(s.x, p.x), y1: Math.min(s.y, p.y), x2: Math.max(s.x, p.x), y2: Math.max(s.y, p.y) });
    };
    const onDrawUp = () => {
        const d = draft;
        dragStart.current = null;
        setDraft(null);
        if (d && d.x2 - d.x1 > 0.01 && d.y2 - d.y1 > 0.01 && boxes.length < 20) setBoxes((b) => [...b, d]);
    };
    /** 比例框 → wrap 内 px 样式 */
    const boxStyle = (b: RatioBox): React.CSSProperties | null => {
        if (!content) return null;
        return {
            position: "absolute",
            left: content.x + b.x1 * content.w,
            top: content.y + b.y1 * content.h,
            width: (b.x2 - b.x1) * content.w,
            height: (b.y2 - b.y1) * content.h,
        };
    };

    const needBoxes = isDesub && region === "partial";
    const round3 = (n: number) => Math.round(n * 1000) / 1000;

    // 图像超分目标 → 上游 multiple（源图尺寸就绪后换算；单边≤6000 夹紧；版本上限 standard≤8 其余≤30）
    const IMG_EDGE_MAX = 6000;
    const IMG_TARGETS: { v: string; label: string }[] = [
        { v: "1", label: "1x（仅增强不放大）" },
        { v: "1.5", label: "1.5x" },
        { v: "2", label: "2x" },
        { v: "4", label: "4x" },
        { v: "2k", label: "2K（长边 2048，短边按比例）" },
        { v: "4k", label: "4K（长边 3840，短边按比例）" },
    ];
    const imgPlan = useMemo(() => {
        if (!isImage) return null;
        const sw = vDim?.w ?? 0, sh = vDim?.h ?? 0;
        if (!sw || !sh) return null;
        const long = Math.max(sw, sh);
        const want = imgTarget === "2k" ? 2048 / long : imgTarget === "4k" ? 3840 / long : Number(imgTarget) || 2;
        const verCap = String(params.tool_version) === "standard" ? 8 : 30;
        const multiple = round3(Math.max(1, Math.min(want, IMG_EDGE_MAX / long, verCap)));
        const outW = Math.round(sw * multiple), outH = Math.round(sh * multiple);
        const capped = want > multiple + 1e-9;
        return { multiple, outW, outH, sw, sh, capped };
    }, [isImage, vDim, imgTarget, params.tool_version]);

    const canConfirm = !!model && (!needBoxes || boxes.length > 0) && (!isImage || !!imgPlan);

    const confirm = () => {
        if (!model) return;
        const out: Record<string, unknown> = { ...params };
        if (needBoxes) {
            out.erase_ratio_location = boxes.slice(0, 20).map((b) => ({
                top_left_x: round3(b.x1), top_left_y: round3(b.y1),
                bottom_right_x: round3(b.x2), bottom_right_y: round3(b.y2),
            }));
        }
        if (isImage && imgPlan) out.multiple = imgPlan.multiple;
        onConfirm({ modelKey: model.id, modelLabel: model.label, params: out });
    };

    return (
        <>
            <div onClick={onCancel} style={{ position: "fixed", inset: 0, zIndex: 10500, background: "rgba(0,0,0,0.55)" }} />
            <div style={{ position: "fixed", zIndex: 10501, top: "50%", left: "50%", transform: "translate(-50%,-50%)", width: 520, maxWidth: "92vw", maxHeight: "90vh", overflowY: "auto", padding: 18, borderRadius: 12, background: "#161b26", border: "1px solid rgba(255,255,255,0.14)", boxShadow: "0 12px 40px rgba(0,0,0,0.6)", display: "flex", flexDirection: "column", gap: 12 }}>
                <div style={{ fontSize: 14, fontWeight: 600, color: "#fff" }}>
                    {modeTitle}{sourceName ? ` · ${sourceName}` : ""}
                </div>

                {/* 预览（图像/视频）+ 局部画框层（画框态盖住播放器交互，退出局部即恢复） */}
                <div ref={wrapRef} style={{ position: "relative", width: "100%", lineHeight: 0 }}>
                    {isImage ? (
                        <img
                            src={displayUri}
                            alt={sourceName}
                            onLoad={(e) => {
                                const im = e.currentTarget;
                                if (im.naturalWidth && im.naturalHeight) setVDim({ w: im.naturalWidth, h: im.naturalHeight });
                            }}
                            style={{ width: "100%", maxHeight: 260, objectFit: "contain", borderRadius: 8, background: "#000", display: "block" }}
                        />
                    ) : (
                    <video
                        ref={videoRef}
                        src={displayUri}
                        controls={!needBoxes}
                        onLoadedMetadata={(e) => {
                            const v = e.currentTarget;
                            if (v.videoWidth && v.videoHeight) setVDim({ w: v.videoWidth, h: v.videoHeight });
                        }}
                        style={{ width: "100%", maxHeight: 260, borderRadius: 8, background: "#000", display: "block" }}
                    />
                    )}
                    {needBoxes && (
                        <div
                            onMouseDown={onDrawDown}
                            onMouseMove={onDrawMove}
                            onMouseUp={onDrawUp}
                            onMouseLeave={onDrawUp}
                            style={{ position: "absolute", inset: 0, cursor: "crosshair", borderRadius: 8, background: "rgba(0,0,0,0.15)" }}
                            title="按住拖拽框选擦除区域（可画多个）"
                        >
                            {boxes.map((b, i) => {
                                const st = boxStyle(b);
                                return st && (
                                    <div key={i} style={{ ...st, border: "1.5px solid #f87171", background: "rgba(248,113,113,0.15)", borderRadius: 2 }}>
                                        <button
                                            onMouseDown={(e) => e.stopPropagation()}
                                            onClick={(e) => { e.stopPropagation(); setBoxes((bs) => bs.filter((_, j) => j !== i)); }}
                                            title="删除该区域"
                                            style={{ position: "absolute", top: -9, right: -9, width: 18, height: 18, lineHeight: "16px", borderRadius: 9, border: "1px solid rgba(255,255,255,0.3)", background: "#161b26", color: "#f87171", fontSize: 11, cursor: "pointer", padding: 0 }}
                                        >×</button>
                                    </div>
                                );
                            })}
                            {draft && boxStyle(draft) && (
                                <div style={{ ...boxStyle(draft)!, border: "1.5px dashed #f87171", background: "rgba(248,113,113,0.1)", borderRadius: 2, pointerEvents: "none" }} />
                            )}
                            {boxes.length === 0 && !draft && (
                                <div style={{ position: "absolute", inset: 0, display: "flex", alignItems: "center", justifyContent: "center", pointerEvents: "none" }}>
                                    <span style={{ fontSize: 12, color: "#fff", background: "rgba(0,0,0,0.55)", padding: "6px 12px", borderRadius: 6, lineHeight: 1.5 }}>在画面上按住拖拽，框选要擦除的区域</span>
                                </div>
                            )}
                        </div>
                    )}
                </div>

                {capModels.length === 0 ? (
                    <div style={{ fontSize: 12, color: "#f87171" }}>
                        管理端未下发{isImage ? "图像超分" : isUp ? "超分" : "去字幕"}模型（capability={cap}）。请更新服务端并在管理端「火山引擎 MediaKit」渠道填入 API Key。
                    </div>
                ) : (
                    <ModelPicker cap={cap} label={isImage ? "图像超分" : isUp ? "超分方式（4 种版本）" : "去字幕方式"} noPlaceholder />
                )}

                {/* 所选模型的动态参数（enum→下拉（值中文化显示）/ number→数字框） */}
                {(model?.params ?? []).map((f) => (
                    <label key={f.key} style={{ display: "flex", alignItems: "center", gap: 10, fontSize: 12, color: "rgba(255,255,255,0.6)" }}>
                        <span style={{ width: 96, flexShrink: 0 }}>{f.label}{f.unit ? `（${f.unit}）` : ""}</span>
                        {f.type === "enum" ? (
                            <select value={String(params[f.key] ?? "")} onChange={(e) => setP(f.key, e.target.value)} style={{ ...fld, cursor: "pointer" }}>
                                {(f.options ?? []).map((o) => <option key={o} value={o} style={optBg}>{optLabel(f.key, o)}</option>)}
                            </select>
                        ) : f.type === "number" ? (
                            <input type="number" value={Number(params[f.key] ?? 0)} min={f.min} max={f.max} step={f.step}
                                onChange={(e) => setP(f.key, Number(e.target.value) || 0)} style={fld} />
                        ) : (
                            <input value={String(params[f.key] ?? "")} onChange={(e) => setP(f.key, e.target.value)} style={fld} />
                        )}
                    </label>
                ))}

                {/* 图像超分：目标（倍率 / 长边分辨率，统一换算 multiple；单边≤6000 自动夹紧） */}
                {isImage && (
                    <>
                        <label style={{ display: "flex", alignItems: "center", gap: 10, fontSize: 12, color: "rgba(255,255,255,0.6)" }}>
                            <span style={{ width: 96, flexShrink: 0 }}>目标</span>
                            <select value={imgTarget} onChange={(e) => setImgTarget(e.target.value)} style={{ ...fld, cursor: "pointer" }}>
                                {IMG_TARGETS.map((t) => <option key={t.v} value={t.v} style={optBg}>{t.label}</option>)}
                            </select>
                        </label>
                        <div style={{ fontSize: 11, color: "rgba(255,255,255,0.45)", marginTop: -4 }}>
                            {imgPlan
                                ? <>源图 {imgPlan.sw}×{imgPlan.sh} → 预计输出 <span style={{ color: "#c4b5fd" }}>{imgPlan.outW}×{imgPlan.outH}</span> px（×{imgPlan.multiple}{imgPlan.capped ? "，已按单边≤6000/版本上限夹紧" : ""}），PNG</>
                                : "读取源图尺寸中…"}
                        </div>
                    </>
                )}

                {/* 去字幕：擦除范围（全屏=上游自动检测；局部=画面上画框限定） */}
                {isDesub && (
                    <div style={{ display: "flex", alignItems: "center", gap: 10, fontSize: 12, color: "rgba(255,255,255,0.6)" }}>
                        <span style={{ width: 96, flexShrink: 0 }}>擦除范围</span>
                        <div style={{ display: "flex", gap: 6, alignItems: "center", flexWrap: "wrap" }}>
                            <button style={segBtn(region === "full")} onClick={() => setRegion("full")}>全屏（自动检测）</button>
                            <button style={segBtn(region === "partial")} onClick={() => setRegion("partial")}>局部（画框限定）</button>
                            {region === "partial" && (
                                <span style={{ fontSize: 11, color: boxes.length ? "#c4b5fd" : "#f87171" }}>
                                    已框选 {boxes.length}/20{boxes.length === 0 ? "（至少画一个）" : ""}
                                    {boxes.length > 0 && (
                                        <button style={{ ...segBtn(false), marginLeft: 6, padding: "2px 8px", fontSize: 11 }} onClick={() => setBoxes([])}>清空</button>
                                    )}
                                </span>
                            )}
                        </div>
                    </div>
                )}

                <div style={{ fontSize: 11, color: "rgba(255,255,255,0.4)", lineHeight: 1.6 }}>
                    {isImage
                        ? "同步处理（火山引擎），完成自动回填：资产模式=故事板历史新增超分记录（右击可对比原图），画布=结果写入新节点。"
                        : `异步处理（火山引擎），完成自动回填：资产模式=本镜视频区新记录（标号 源记录号${isUp ? "+" : "-"}，右击可对比原视频），画布=结果写入新节点。`}
                    {model ? ` 本次预计消耗 ${model.cost} 积分。` : ""}
                </div>
                <div style={{ display: "flex", justifyContent: "flex-end", gap: 8 }}>
                    <button style={ghost} onClick={onCancel}>取消</button>
                    <button
                        style={{ ...primary, opacity: canConfirm ? 1 : 0.5, cursor: canConfirm ? "pointer" : "not-allowed" }}
                        disabled={!canConfirm}
                        title={needBoxes && boxes.length === 0 ? "局部擦除需至少框选一个区域" : undefined}
                        onClick={confirm}
                    >
                        {isDesub ? "开始去字幕" : "开始超分"}
                    </button>
                </div>
            </div>
        </>
    );
}
