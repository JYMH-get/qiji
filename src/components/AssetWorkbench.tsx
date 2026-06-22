import { useState, useEffect, useMemo, useRef } from "react";
import { useNavigate } from "react-router";
import { useProjectStore, type AssetCat } from "@/store/projectStore";
import { runPurpose } from "@/services/purposeRunner";
import { startGeneration, retryGeneration } from "@/services/generationQueue";
import ModelPicker, { effectiveModelKey } from "@/components/ModelPicker";
import type { Purpose } from "@/contract";

interface AssetWorkbenchProps {
    cat: AssetCat;                 // 角色/场景/生物/物品/群像 对应的 store 数组字段
    unit: string;                  // 单位名，如「角色」「场景」
    imagePurpose: Purpose;         // 出图 purpose，如 asset.character.image
    textField: "features" | "description"; // 角色/群像=features，其余=description
    showVoice?: boolean;           // 是否显示音色选择（角色/群像）
}

type Form = {
    key: string;                   // "base" 或 变体 id
    variantId: string | null;     // null=基础形象
    label: string;                 // 徽标
    title: string;                 // 标题（名称）
    desc: string;                  // 副标题/说明
    prompt: string;
    image?: string;
    images: string[];
};

const QUALITIES = ["auto", "low", "medium", "high"];
// 比例（界面选）
const ASPECTS: Array<{ v: string; label: string }> = [
    { v: "1:1", label: "1：1" },
    { v: "16:9", label: "16：9" },
    { v: "9:16", label: "9：16" },
];
// 分辨率档（界面选）
const RESOLUTIONS: Array<{ v: string; label: string }> = [
    { v: "1k", label: "1K" },
    { v: "2k", label: "2K" },
    { v: "4k", label: "4K" },
];
// (比例, 分辨率档) → 实际请求的具体分辨率（请求仍用具体像素表示）
const SIZE_MAP: Record<string, Record<string, string>> = {
    "1:1": { "1k": "1024x1024", "2k": "2048x2048", "4k": "4096x4096" },
    "16:9": { "1k": "1024x576", "2k": "2048x1152", "4k": "3840x2160" },
    "9:16": { "1k": "576x1024", "2k": "1152x2048", "4k": "2160x3840" },
};
function resolveSize(aspect: string, resolution: string): string {
    return SIZE_MAP[aspect]?.[resolution] ?? "1024x1024";
}

// 资产 id 类型前缀（管理端据此分配 C00000123 等）：角色 C / 群像 G / 场景 S / 生物 M / 物品 P
const CAT_PREFIX: Record<AssetCat, string> = { characters: "C", crowds: "G", scenes: "S", organisms: "M", items: "P" };

const panel: React.CSSProperties = { background: "rgba(255,255,255,0.03)", border: "1px solid rgba(255,255,255,0.08)", borderRadius: 8 };
const accent = "#8b5cf6";

const AssetWorkbench = ({ cat, unit, imagePurpose, textField, showVoice }: AssetWorkbenchProps) => {
    const navigate = useNavigate();
    const assets = useProjectStore((s) => s[cat]) as any[];
    const {
        updateAsset, addAssetVariant, updateAssetVariant, setAssetMainImage, removePendingGen,
    } = useProjectStore.getState();

    const [selectedId, setSelectedId] = useState<string | null>(null);
    const [selectedFormKey, setSelectedFormKey] = useState<string>("base");
    const [searchQuery, setSearchQuery] = useState("");
    const [quality, setQuality] = useState("auto");
    const [aspect, setAspect] = useState("1:1");
    const [resolution, setResolution] = useState("1k");
    // 区5 图片：自然分辨率信息 + 框内缩放/平移
    const [imgDims, setImgDims] = useState<{ w: number; h: number } | null>(null);
    const [imgScale, setImgScale] = useState(1);
    const [imgOffset, setImgOffset] = useState({ x: 0, y: 0 });
    const dragRef = useRef<{ x: number; y: number; ox: number; oy: number } | null>(null);
    const pendingGens = useProjectStore((s) => s.pendingGens);
    const [optimizing, setOptimizing] = useState(false);
    // 垫图（图生图参考素材）：本地上传或从资产库选
    const [refImages, setRefImages] = useState<Array<{ uri: string; name?: string }>>([]);
    const [refPickerOpen, setRefPickerOpen] = useState(false);

    // 资产库可选垫图（跨类：角色/群像/场景/生物/物品的主图）
    const allCats = useProjectStore((s) => ({ characters: s.characters, crowds: s.crowds, scenes: s.scenes, organisms: s.organisms, items: s.items }));
    const libraryImages = useMemo(() => {
        const out: Array<{ uri: string; name: string }> = [];
        for (const arr of Object.values(allCats)) {
            for (const a of arr as any[]) if (a.image) out.push({ uri: a.image, name: a.name });
        }
        return out;
    }, [allCats]);

    const addLocalRef = (file: File) => {
        const reader = new FileReader();
        reader.onload = () => setRefImages((prev) => [...prev, { uri: String(reader.result), name: file.name }]);
        reader.readAsDataURL(file);
    };

    // 垫图引用需服务端可 fetch：本地 uri(asset://) 解析回公网 url（图生图底图）
    const toRefUri = (displayUri: string) => useProjectStore.getState().blobByUri(displayUri)?.url || displayUri;

    // 拖放到垫图素材区：资产助手卡片 / 本地图片文件 → 垫图
    const onRefDrop = (e: React.DragEvent) => {
        e.preventDefault();
        const raw = e.dataTransfer.getData("application/x-qiji-asset") || e.dataTransfer.getData("text/plain");
        if (raw) {
            try {
                const d = JSON.parse(raw);
                // 垫图引用优先用公网 url（服务端可 fetch 做图生图），否则本地 uri
                const u = d?.url || d?.localUri || d?.uri;
                if (u) { setRefImages((prev) => prev.some((r) => r.uri === u) ? prev : [...prev, { uri: u, name: d.name }]); return; }
            } catch { /* 非 JSON，落到文件分支 */ }
        }
        const f = e.dataTransfer.files?.[0];
        if (f && f.type.startsWith("image/")) {
            // 原生拖入的资产文件名为 <assetId>.<ext> → 解析回三元映射，垫图用公网 url（无需重读字节）
            const base = f.name.replace(/\.[^.]+$/, "");
            const blob = useProjectStore.getState().assetBlobs[base];
            const ref = blob?.url || blob?.localUri;
            if (ref) setRefImages((prev) => prev.some((r) => r.uri === ref) ? prev : [...prev, { uri: ref, name: f.name }]);
            else addLocalRef(f);
        }
    };

    useEffect(() => {
        if (assets.length > 0 && !assets.find((a) => a.id === selectedId)) {
            setSelectedId(assets[0].id);
            setSelectedFormKey("base");
        }
    }, [assets, selectedId]);

    const activeAsset = assets.find((a) => a.id === selectedId) || null;

    // 当前资产的「分体/造型」列表：基础形象为第 1 个，其后为变体
    const forms: Form[] = useMemo(() => {
        if (!activeAsset) return [];
        const base: Form = {
            key: "base", variantId: null, label: "基础形象", title: activeAsset.name,
            desc: activeAsset[textField] || "", prompt: activeAsset.prompt || "",
            image: activeAsset.image, images: activeAsset.images || [],
        };
        const variants: Form[] = (activeAsset.variants || []).map((v: any) => ({
            key: v.id, variantId: v.id, label: v.label || "造型", title: v.name || activeAsset.name,
            desc: v.description || "", prompt: v.prompt || "", image: v.image, images: v.images || [],
        }));
        return [base, ...variants];
    }, [activeAsset, textField]);

    const activeForm = forms.find((f) => f.key === selectedFormKey) || forms[0] || null;

    // 切换显示图片时复位框内缩放/平移
    useEffect(() => { setImgScale(1); setImgOffset({ x: 0, y: 0 }); }, [activeForm?.image]);

    // 选择造型时初始化垫图：分体（变体）默认参考基础形象，基础形象默认无垫图；用户可增删
    useEffect(() => {
        if (activeForm?.variantId && activeAsset?.image) {
            setRefImages([{ uri: toRefUri(activeAsset.image), name: `${activeAsset.name}·基础形象` }]);
        } else {
            setRefImages([]);
        }
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [selectedId, selectedFormKey]);

    const filtered = assets.filter((a) =>
        a.name?.toLowerCase().includes(searchQuery.toLowerCase()) ||
        (a[textField] || "").toLowerCase().includes(searchQuery.toLowerCase())
    );

    const writePrompt = (form: Form, prompt: string) => {
        if (form.variantId) updateAssetVariant(cat, activeAsset.id, form.variantId, { prompt });
        else updateAsset(cat, activeAsset.id, { prompt });
    };

    // 在途任务（断连保护）：按 资产+造型 过滤；运行中=占位、失败=标红可重试
    const pendingFor = (assetId: string, variantId: string | null) =>
        pendingGens.filter((p) => p.cat === cat && p.assetId === assetId && p.variantId === variantId);
    const isRunning = (assetId: string, variantId: string | null) =>
        pendingFor(assetId, variantId).some((p) => p.status === "running");

    // 生成一张：交给 generationQueue 持久化在途任务（切页/关软件不丢；UI 由 pendingGens 驱动）
    const generateForm = (assetId: string, form: Form) => {
        if (!form.prompt.trim()) { alert("该造型暂无提示词，请先填写出图提示词。"); return; }
        const modelKey = effectiveModelKey("image");
        const size = resolveSize(aspect, resolution);
        // 有垫图 → 图生图：把参考图作为 input.images 传入
        const input = refImages.length ? { images: refImages.map((r) => ({ url: r.uri })) } : undefined;
        startGeneration({ cat, assetId, variantId: form.variantId, purpose: imagePurpose, prompt: form.prompt, modelKey, input, params: { size, quality, idPrefix: CAT_PREFIX[cat], assetName: form.title }, label: form.title });
    };

    // 区域2 一键生成：为所有资产生成「基础形象」
    const generateAllBase = () => {
        const modelKey = effectiveModelKey("image");
        const size = resolveSize(aspect, resolution);
        for (const a of assets) {
            if (a.prompt?.trim()) startGeneration({ cat, assetId: a.id, variantId: null, purpose: imagePurpose, prompt: a.prompt, modelKey, params: { size, quality, idPrefix: CAT_PREFIX[cat], assetName: a.name }, label: a.name });
        }
    };

    // 区域3 一键生成：为当前资产的所有造型（基础+变体）各生成一张
    const generateAllForms = () => {
        if (!activeAsset) return;
        for (const f of forms) {
            if (f.prompt.trim()) generateForm(activeAsset.id, f);
        }
    };

    const addVariant = () => {
        if (!activeAsset) return;
        const vid = `v-${Date.now()}`;
        addAssetVariant(cat, activeAsset.id, {
            id: vid, label: "新造型", name: activeAsset.name, description: "",
            prompt: activeAsset.prompt || "", image: undefined, images: [],
        });
        setSelectedFormKey(vid);
    };

    // 提示词优化：调文本模型润色当前造型的出图提示词后回填
    const optimizePrompt = async () => {
        if (!activeAsset || !activeForm) return;
        if (!activeForm.prompt.trim()) { alert("提示词为空，无可优化内容。"); return; }
        setOptimizing(true);
        try {
            // 润色提示词正文留服务端（内部模板 asset.prompt.optimize）；只发变量 原提示词
            const run = await runPurpose("script.analyze", { templateId: "asset.prompt.optimize", variables: { 原提示词: activeForm.prompt }, modelKey: effectiveModelKey("text") || undefined, params: { temperature: 0.6, maxTokens: 2048 } });
            if (run.status === "success" && run.resultUri && run.resultUri.trim()) {
                writePrompt(activeForm, run.resultUri.trim());
                await useProjectStore.getState().save(true);
            } else if (run.status === "no_model") {
                alert("未配置可用的文本模型，无法优化提示词。");
            } else {
                alert(`优化失败：${run.status === "failed" ? run.error : "模型返回为空"}`);
            }
        } finally {
            setOptimizing(false);
        }
    };

    // 当前造型的在途生成状态（驱动区5 的「生成中 / 失败」显示）
    const activePendings = activeAsset && activeForm ? pendingFor(activeAsset.id, activeForm.variantId) : [];
    const runningPending = activePendings.find((p) => p.status === "running");
    const failedPending = activePendings.filter((p) => p.status === "failed").slice(-1)[0];

    return (
        <div style={{ flex: 1, minWidth: 0, display: "flex", gap: 10, padding: "10px 10px 10px 0", height: "100%", boxSizing: "border-box" }}>

            {/* 区域2：资产列表（不变） */}
            <div style={{ width: 230, display: "flex", flexDirection: "column", gap: 10, ...panel, padding: 10 }}>
                <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between" }}>
                    <span style={{ fontSize: 13, fontWeight: 600, color: "#fff" }}>{unit}列表</span>
                    <div style={{ display: "flex", gap: 10, fontSize: 11 }}>
                        <span onClick={generateAllBase} style={{ color: "rgba(255,255,255,0.6)", cursor: "pointer" }}>一键生成</span>
                        <span style={{ color: "rgba(255,255,255,0.6)", cursor: "pointer" }}>管理</span>
                        <span style={{ color: accent, cursor: "pointer" }}>+ 新建</span>
                    </div>
                </div>
                <input placeholder="搜索名称..." value={searchQuery} onChange={(e) => setSearchQuery(e.target.value)}
                    style={{ ...panel, padding: "6px 8px", color: "#fff", fontSize: 12, outline: "none" }} />
                <div style={{ display: "flex", flexDirection: "column", gap: 8, overflowY: "auto", flex: 1 }}>
                    {assets.length === 0 ? (
                        <div style={{ padding: "40px 10px", textAlign: "center", color: "rgba(255,255,255,0.4)", fontSize: 12 }}>
                            <p>暂无{unit}数据，请先提取剧本资产</p>
                            <button onClick={() => navigate("/frame1693")} style={{ marginTop: 12, padding: "6px 14px", background: accent, color: "#fff", border: "none", borderRadius: 6, cursor: "pointer", fontSize: 12 }}>前往剧本配置</button>
                        </div>
                    ) : filtered.map((a) => {
                        const isActive = a.id === selectedId;
                        return (
                            <div key={a.id} onClick={() => { setSelectedId(a.id); setSelectedFormKey("base"); }}
                                style={{ ...panel, display: "flex", gap: 8, padding: 8, cursor: "pointer", background: isActive ? "rgba(139,92,246,0.12)" : "rgba(255,255,255,0.03)", borderColor: isActive ? accent : "rgba(255,255,255,0.08)" }}>
                                <div style={{ width: 40, height: 40, borderRadius: 6, flexShrink: 0, background: a.image ? `center/cover no-repeat url(${a.image})` : "rgba(255,255,255,0.06)" }} />
                                <div style={{ minWidth: 0 }}>
                                    <div style={{ color: "#fff", fontSize: 13, whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>{a.name}</div>
                                    <div style={{ color: "rgba(255,255,255,0.45)", fontSize: 11, whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>{(a[textField] || "").slice(0, 22) || "—"}</div>
                                </div>
                            </div>
                        );
                    })}
                </div>
            </div>

            {/* 区域3：当前资产的分体/造型列表（基础形象为第一个） */}
            <div style={{ width: 200, display: "flex", flexDirection: "column", gap: 10, ...panel, padding: 10 }}>
                <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between" }}>
                    <span style={{ fontSize: 13, fontWeight: 600, color: "#fff" }}>造型 / 分体</span>
                    <div style={{ display: "flex", gap: 8, fontSize: 11 }}>
                        <span onClick={() => activeAsset && generateAllForms()} style={{ color: "rgba(255,255,255,0.6)", cursor: "pointer" }}>一键生成</span>
                        <span onClick={addVariant} style={{ color: accent, cursor: "pointer" }}>+ 新建</span>
                    </div>
                </div>
                <div style={{ display: "flex", flexDirection: "column", gap: 8, overflowY: "auto", flex: 1 }}>
                    {!activeAsset ? (
                        <div style={{ padding: 24, textAlign: "center", color: "rgba(255,255,255,0.4)", fontSize: 12 }}>请选择左侧{unit}</div>
                    ) : forms.map((f) => {
                        const isActive = f.key === selectedFormKey;
                        const isBusy = isRunning(activeAsset.id, f.variantId);
                        return (
                            <div key={f.key} onClick={() => setSelectedFormKey(f.key)}
                                style={{ ...panel, padding: 8, cursor: "pointer", background: isActive ? "rgba(139,92,246,0.12)" : "rgba(255,255,255,0.03)", borderColor: isActive ? accent : "rgba(255,255,255,0.08)" }}>
                                <div style={{ width: "100%", aspectRatio: "1/1", borderRadius: 6, background: f.image ? `center/cover no-repeat url(${f.image})` : "rgba(255,255,255,0.06)", display: "flex", alignItems: "center", justifyContent: "center", color: "rgba(255,255,255,0.3)", fontSize: 11 }}>
                                    {isBusy ? "生成中…" : (!f.image ? "未生成" : "")}
                                </div>
                                <div style={{ marginTop: 6, display: "flex", alignItems: "center", gap: 6 }}>
                                    <span style={{ fontSize: 10, padding: "1px 6px", borderRadius: 4, background: f.variantId ? "rgba(255,255,255,0.08)" : accent, color: "#fff" }}>{f.label}</span>
                                    <span style={{ fontSize: 11, color: "rgba(255,255,255,0.6)", whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>{f.title}</span>
                                </div>
                            </div>
                        );
                    })}
                </div>
            </div>

            {/* 区域4：提示词与生成控制 */}
            <div style={{ width: 320, display: "flex", flexDirection: "column", gap: 12, ...panel, padding: 12, overflowY: "auto" }}>
                {!activeForm ? (
                    <div style={{ color: "rgba(255,255,255,0.4)", fontSize: 12, margin: "auto" }}>请选择造型</div>
                ) : (
                    <>
                        <div style={{ color: "#fff", fontSize: 14, fontWeight: 600 }}>{activeForm.title}　<span style={{ fontSize: 11, color: "rgba(255,255,255,0.5)" }}>{activeForm.label}</span></div>

                        {/* 1. 设计理念 / 说明（仅展示，不进入请求） */}
                        {activeForm.desc && (
                            <div style={{ ...panel, padding: 8 }}>
                                <div style={{ fontSize: 11, color: "rgba(255,255,255,0.5)", marginBottom: 4 }}>设计理念 / 说明（仅展示，不参与生成）</div>
                                <div style={{ fontSize: 11, color: "rgba(255,255,255,0.7)", lineHeight: 1.5 }}>{activeForm.desc}</div>
                            </div>
                        )}

                        {/* 2. 出图提示词（占满剩余空间） */}
                        <div style={{ flex: 1, minHeight: 0, display: "flex", flexDirection: "column" }}>
                            <div style={{ fontSize: 11, color: "rgba(255,255,255,0.6)", marginBottom: 4 }}>出图提示词</div>
                            <textarea value={activeForm.prompt} onChange={(e) => writePrompt(activeForm, e.target.value)}
                                style={{ flex: 1, minHeight: 140, width: "100%", ...panel, color: "#fff", fontSize: 11, lineHeight: 1.5, padding: 8, outline: "none", resize: "none", boxSizing: "border-box" }} />
                        </div>

                        {/* 2b. 垫图素材区（图生图，可选；支持从资产助手拖入） */}
                        <div style={{ position: "relative" }} onDragOver={(e) => e.preventDefault()} onDrop={onRefDrop}>
                            <div style={{ fontSize: 11, color: "rgba(255,255,255,0.6)", marginBottom: 4 }}>垫图素材　<span style={{ color: "rgba(255,255,255,0.35)" }}>（可选，图生图参考；可从资产助手拖入）</span></div>
                            <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
                                {refImages.map((r, i) => (
                                    <div key={i} title={r.name || "垫图"} style={{ position: "relative", width: 48, height: 48, borderRadius: 6, overflow: "hidden", border: "1px solid rgba(255,255,255,0.15)", background: `center/cover no-repeat url(${r.uri})` }}>
                                        <span onClick={() => setRefImages((prev) => prev.filter((_, j) => j !== i))}
                                            title="移除" style={{ position: "absolute", top: 0, right: 0, width: 16, height: 16, lineHeight: "14px", textAlign: "center", fontSize: 12, color: "#fff", background: "rgba(0,0,0,0.6)", cursor: "pointer" }}>×</span>
                                    </div>
                                ))}
                                <button onClick={() => setRefPickerOpen((v) => !v)} title="添加垫图"
                                    style={{ width: 48, height: 48, borderRadius: 6, border: "1px dashed rgba(255,255,255,0.25)", background: "transparent", color: "rgba(255,255,255,0.5)", cursor: "pointer", fontSize: 20 }}>+</button>
                            </div>
                            {refPickerOpen && (
                                <div style={{ ...panel, position: "absolute", zIndex: 50, left: 0, right: 0, bottom: "100%", marginBottom: 6, padding: 8, background: "#161b26", maxHeight: 300, overflowY: "auto", boxShadow: "0 -8px 24px rgba(0,0,0,0.5)" }}>
                                    <label style={{ display: "block", textAlign: "center", padding: "6px 0", marginBottom: 6, borderRadius: 6, background: "rgba(255,255,255,0.06)", cursor: "pointer", fontSize: 11, color: "#fff" }}>
                                        本地上传
                                        <input type="file" accept="image/*" style={{ display: "none" }}
                                            onChange={(e) => { const f = e.target.files?.[0]; if (f) addLocalRef(f); e.target.value = ""; setRefPickerOpen(false); }} />
                                    </label>
                                    <div style={{ fontSize: 10, color: "rgba(255,255,255,0.4)", margin: "4px 0" }}>从资产库选</div>
                                    {libraryImages.length === 0 ? (
                                        <div style={{ fontSize: 11, color: "rgba(255,255,255,0.4)", padding: 4 }}>资产库暂无可用图片</div>
                                    ) : (
                                        <div style={{ display: "flex", flexWrap: "wrap", gap: 6 }}>
                                            {libraryImages.map((img, i) => (
                                                <div key={i} title={img.name} onClick={() => { setRefImages((prev) => [...prev, { uri: toRefUri(img.uri), name: img.name }]); setRefPickerOpen(false); }}
                                                    style={{ width: 44, height: 44, borderRadius: 6, cursor: "pointer", border: "1px solid rgba(255,255,255,0.12)", background: `center/cover no-repeat url(${img.uri})` }} />
                                            ))}
                                        </div>
                                    )}
                                </div>
                            )}
                        </div>

                        {/* 3a. 绑定音色（独占一行，占位，暂未实现） */}
                        {showVoice && (
                            <div>
                                <div style={{ fontSize: 11, color: "rgba(255,255,255,0.6)", marginBottom: 4 }}>绑定音色　<span style={{ color: "rgba(255,255,255,0.35)" }}>（音色文件将绑定到该角色，暂未实现）</span></div>
                                <div style={{ display: "flex", gap: 8 }}>
                                    <select disabled title="暂未实现" style={{ flex: 1, ...panel, color: "rgba(255,255,255,0.5)", fontSize: 11, padding: "6px 8px", outline: "none", cursor: "not-allowed" }}>
                                        <option style={{ background: "#1f1f2e" }}>未绑定音色</option>
                                    </select>
                                    <button disabled title="暂未实现" style={{ ...panel, color: "rgba(255,255,255,0.5)", fontSize: 11, padding: "6px 10px", cursor: "not-allowed" }}>音色生成</button>
                                    <button disabled title="暂未实现" style={{ ...panel, color: "rgba(255,255,255,0.5)", fontSize: 11, padding: "6px 10px", cursor: "not-allowed" }}>本地上传</button>
                                </div>
                            </div>
                        )}

                        {/* 3b. 出图要求（与提示词一起进入生成请求） */}
                        <div>
                            <div style={{ fontSize: 11, color: "rgba(255,255,255,0.6)", marginBottom: 4 }}>出图要求</div>
                            <ModelPicker cap="image" label="出图模型" style={{ marginBottom: 8 }} />
                            <div style={{ display: "flex", gap: 8 }}>
                                <label style={{ flex: 1, minWidth: 0 }}>
                                    <div style={{ fontSize: 10, color: "rgba(255,255,255,0.45)", marginBottom: 2 }}>质量</div>
                                    <select value={quality} onChange={(e) => setQuality(e.target.value)}
                                        style={{ width: "100%", ...panel, color: "#fff", fontSize: 11, padding: "6px 6px", outline: "none" }}>
                                        {QUALITIES.map((q) => <option key={q} value={q} style={{ background: "#1f1f2e" }}>{q}</option>)}
                                    </select>
                                </label>
                                <label style={{ flex: 1, minWidth: 0 }}>
                                    <div style={{ fontSize: 10, color: "rgba(255,255,255,0.45)", marginBottom: 2 }}>比例</div>
                                    <select value={aspect} onChange={(e) => setAspect(e.target.value)}
                                        style={{ width: "100%", ...panel, color: "#fff", fontSize: 11, padding: "6px 6px", outline: "none" }}>
                                        {ASPECTS.map((a) => <option key={a.v} value={a.v} style={{ background: "#1f1f2e" }}>{a.label}</option>)}
                                    </select>
                                </label>
                                <label style={{ flex: 1, minWidth: 0 }}>
                                    <div style={{ fontSize: 10, color: "rgba(255,255,255,0.45)", marginBottom: 2 }}>分辨率</div>
                                    <select value={resolution} onChange={(e) => setResolution(e.target.value)}
                                        style={{ width: "100%", ...panel, color: "#fff", fontSize: 11, padding: "6px 6px", outline: "none" }}>
                                        {RESOLUTIONS.map((r) => <option key={r.v} value={r.v} style={{ background: "#1f1f2e" }}>{r.label}</option>)}
                                    </select>
                                </label>
                            </div>
                        </div>

                        <div style={{ display: "flex", gap: 10 }}>
                            <button onClick={() => activeAsset && generateForm(activeAsset.id, activeForm)} title="可重复提交，每次生成会在右侧历史区新增一个占位"
                                style={{ flex: 1, padding: "9px 0", background: accent, color: "#fff", border: "none", borderRadius: 6, cursor: "pointer", fontSize: 12 }}>
                                生成形象
                            </button>
                            <button onClick={optimizePrompt} disabled={optimizing}
                                style={{ flex: 1, padding: "9px 0", background: "transparent", color: "#a78bfa", border: `1px solid ${accent}`, borderRadius: 6, cursor: optimizing ? "not-allowed" : "pointer", opacity: optimizing ? 0.7 : 1, fontSize: 12 }}>
                                {optimizing ? "优化中…" : "提示词优化"}
                            </button>
                        </div>
                    </>
                )}
            </div>

            {/* 区域5：图片展示区（主图 + 历史，可选主图） */}
            <div style={{ flex: 1, minWidth: 0, display: "flex", flexDirection: "column", gap: 12, ...panel, padding: 12 }}>
                <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 8 }}>
                    <div style={{ fontSize: 13, fontWeight: 600, color: "#fff" }}>图片展示{activeForm ? `　·　${activeForm.title}（${activeForm.label}）` : ""}</div>
                    {activeForm?.image && imgDims && !runningPending && !failedPending && (
                        <span style={{ fontSize: 11, color: "rgba(255,255,255,0.6)", fontFamily: "monospace", background: "rgba(255,255,255,0.06)", border: "1px solid rgba(255,255,255,0.1)", borderRadius: 5, padding: "2px 8px" }}>
                            {imgDims.w}×{imgDims.h}
                        </span>
                    )}
                </div>
                {!activeForm ? (
                    <div style={{ flex: 1, display: "flex", alignItems: "center", justifyContent: "center", color: "rgba(255,255,255,0.4)", fontSize: 12 }}>请选择左侧造型</div>
                ) : (
                    <>
                        <div
                            onWheel={(e) => { if (activeForm.image && !runningPending && !failedPending) setImgScale((s) => Math.min(8, Math.max(0.5, s * (e.deltaY < 0 ? 1.1 : 0.9)))); }}
                            onMouseDown={(e) => { if (imgScale !== 1) dragRef.current = { x: e.clientX, y: e.clientY, ox: imgOffset.x, oy: imgOffset.y }; }}
                            onMouseMove={(e) => { if (dragRef.current) setImgOffset({ x: dragRef.current.ox + (e.clientX - dragRef.current.x), y: dragRef.current.oy + (e.clientY - dragRef.current.y) }); }}
                            onMouseUp={() => { dragRef.current = null; }}
                            onMouseLeave={() => { dragRef.current = null; }}
                            onDoubleClick={() => { setImgScale(1); setImgOffset({ x: 0, y: 0 }); }}
                            style={{ flex: 1, minHeight: 0, borderRadius: 8, background: "rgba(255,255,255,0.04)", display: "flex", alignItems: "center", justifyContent: "center", color: "rgba(255,255,255,0.35)", fontSize: 13, overflow: "hidden" }}>
                            {/* 主显示区只负责展示选中的主图；生成中/失败作为独立占位放到下方历史区，不抢占主图 */}
                            {activeForm.image ? (
                                <img src={activeForm.image} alt={activeForm.title} title="滚轮缩放 · 拖动平移 · 双击复位" draggable={false}
                                    ref={(el) => {
                                        if (el && el.complete && el.naturalWidth && (!imgDims || imgDims.w !== el.naturalWidth || imgDims.h !== el.naturalHeight)) {
                                            setImgDims({ w: el.naturalWidth, h: el.naturalHeight });
                                        }
                                    }}
                                    onLoad={(e) => setImgDims({ w: e.currentTarget.naturalWidth, h: e.currentTarget.naturalHeight })}
                                    style={{ maxWidth: "100%", maxHeight: "100%", objectFit: "contain", transform: `translate(${imgOffset.x}px, ${imgOffset.y}px) scale(${imgScale})`, transition: dragRef.current ? "none" : "transform 0.06s", cursor: imgScale > 1 ? "grab" : "default", userSelect: "none" }} />
                            ) : runningPending ? (
                                <div style={{ display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center", gap: 10, color: "#c4b5fd", fontSize: 13 }}>
                                    <div style={{ width: 28, height: 28, border: "3px solid rgba(167,139,250,0.3)", borderTopColor: "#a78bfa", borderRadius: "50%", animation: "Qiji-spin 0.8s linear infinite" }} />
                                    生成中…
                                </div>
                            ) : "暂无图片，点击「生成形象」"}
                        </div>
                        <div>
                            <div style={{ fontSize: 11, color: "rgba(255,255,255,0.5)", marginBottom: 6 }}>历史记录（点击设为主图；生成中/失败的任务也在此展示）</div>
                            <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
                                {activeForm.images.filter(Boolean).map((uri, i) => {
                                    const isMain = uri === activeForm.image;
                                    return (
                                        <div key={i} onClick={() => activeAsset && setAssetMainImage(cat, activeAsset.id, activeForm.variantId, uri)}
                                            title={isMain ? "当前主图" : "设为主图"}
                                            style={{ width: 64, height: 64, borderRadius: 6, cursor: "pointer", background: `center/cover no-repeat url(${uri})`, border: isMain ? `2px solid ${accent}` : "2px solid transparent", boxShadow: isMain ? "0 0 0 1px rgba(139,92,246,0.4)" : "none" }} />
                                    );
                                })}
                                {/* 在途占位：每次「生成形象」新增一个独立占位（运行中=生成中 / 失败=标红可重试/删除），不影响主图 */}
                                {activeAsset && pendingFor(activeAsset.id, activeForm.variantId).map((p) => (
                                    p.status === "running" ? (
                                        <div key={p.id} title="生成中（切页/关软件不丢，完成自动回填）"
                                            style={{ width: 64, height: 64, borderRadius: 6, border: "2px dashed rgba(139,92,246,0.5)", background: "rgba(139,92,246,0.08)", display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center", gap: 4, color: "#a78bfa", fontSize: 10 }}>
                                            <div style={{ width: 16, height: 16, border: "2px solid rgba(167,139,250,0.3)", borderTopColor: "#a78bfa", borderRadius: "50%", animation: "Qiji-spin 0.8s linear infinite" }} />
                                            生成中
                                        </div>
                                    ) : (
                                        <div key={p.id} title={`失败：${p.error || ""}`}
                                            style={{ width: 64, height: 64, borderRadius: 6, border: "2px solid #f87171", background: "rgba(248,113,113,0.12)", display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center", gap: 2, color: "#fca5a5", fontSize: 10 }}>
                                            <span>失败</span>
                                            <div style={{ display: "flex", gap: 4 }}>
                                                <span onClick={() => retryGeneration(p.id)} title="重试" style={{ cursor: "pointer", textDecoration: "underline" }}>重试</span>
                                                <span onClick={() => removePendingGen(p.id)} title="删除" style={{ cursor: "pointer", textDecoration: "underline" }}>删除</span>
                                            </div>
                                        </div>
                                    )
                                ))}
                                {activeForm.images.filter(Boolean).length === 0 && (!activeAsset || pendingFor(activeAsset.id, activeForm.variantId).length === 0) && (
                                    <span style={{ color: "rgba(255,255,255,0.3)", fontSize: 12 }}>暂无历史</span>
                                )}
                            </div>
                        </div>
                    </>
                )}
            </div>
        </div>
    );
};

export default AssetWorkbench;
