import { useState, useEffect, useMemo } from "react";
import { useNavigate } from "react-router";
import { useProjectStore, type AssetCat } from "@/store/projectStore";
import { runPurpose } from "@/services/purposeRunner";
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

const GEN_COUNTS = [1, 2, 3, 4];
const QUALITIES = ["auto", "low", "medium", "high"];
// 比例 / 分辨率（与提示词一起进入生成请求）
const SIZES: Array<{ v: string; label: string }> = [
    { v: "1024x1024", label: "1024×1024 1：1" },
    { v: "1536x1024", label: "1536×1024 3：2" },
    { v: "1024x1536", label: "1024×1536 2：3" },
    { v: "2048x2048", label: "2048×2048 1：1" },
    { v: "2048x1152", label: "2048×1152 16：9" },
    { v: "1152x2048", label: "1152×2048 9：16" },
    { v: "3840x2160", label: "3840×2160 16：9" },
    { v: "2160x3840", label: "2160×3840 9：16" },
];

// 资产 id 类型前缀（管理端据此分配 C00000123 等）：角色 C / 群像 G / 场景 S / 生物 M / 物品 P
const CAT_PREFIX: Record<AssetCat, string> = { characters: "C", crowds: "G", scenes: "S", organisms: "M", items: "P" };

const panel: React.CSSProperties = { background: "rgba(255,255,255,0.03)", border: "1px solid rgba(255,255,255,0.08)", borderRadius: 8 };
const accent = "#8b5cf6";

const AssetWorkbench = ({ cat, unit, imagePurpose, textField, showVoice }: AssetWorkbenchProps) => {
    const navigate = useNavigate();
    const assets = useProjectStore((s) => s[cat]) as any[];
    const {
        updateAsset, addAssetVariant, updateAssetVariant, addAssetImage, setAssetMainImage,
    } = useProjectStore.getState();

    const [selectedId, setSelectedId] = useState<string | null>(null);
    const [selectedFormKey, setSelectedFormKey] = useState<string>("base");
    const [searchQuery, setSearchQuery] = useState("");
    const [genCount, setGenCount] = useState(1);
    const [quality, setQuality] = useState("auto");
    const [size, setSize] = useState(SIZES[0].v);
    const [busy, setBusy] = useState<Record<string, boolean>>({});
    const [optimizing, setOptimizing] = useState(false);
    const [bulkRunning, setBulkRunning] = useState(false);

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

    const filtered = assets.filter((a) =>
        a.name?.toLowerCase().includes(searchQuery.toLowerCase()) ||
        (a[textField] || "").toLowerCase().includes(searchQuery.toLowerCase())
    );

    const writePrompt = (form: Form, prompt: string) => {
        if (form.variantId) updateAssetVariant(cat, activeAsset.id, form.variantId, { prompt });
        else updateAsset(cat, activeAsset.id, { prompt });
    };

    // 生成一张/多张图，落入该 form 的历史，最新一张设为主图
    const generateForm = async (assetId: string, form: Form, count: number) => {
        if (!form.prompt.trim()) { alert("该造型暂无提示词，请先填写出图提示词。"); return; }
        const busyKey = `${assetId}:${form.key}`;
        setBusy((p) => ({ ...p, [busyKey]: true }));
        try {
            for (let i = 0; i < count; i++) {
                const run = await runPurpose(imagePurpose, { prompt: form.prompt, params: { size, quality, idPrefix: CAT_PREFIX[cat], assetName: form.title } });
                if (run.status === "no_model") throw new Error("未配置可用的图像模型，请先在「设置 → 模型」中选择后重试。");
                if (run.status === "failed") throw new Error(run.error || "生成失败");
                if (!run.resultUri) throw new Error("模型返回为空，未生成图片。");
                addAssetImage(cat, assetId, form.variantId, run.resultUri, true);
            }
            await useProjectStore.getState().save(true);
        } catch (err) {
            console.error("generate failed:", err);
            alert(`生成失败：${err instanceof Error ? err.message : "未知错误"}`);
        } finally {
            setBusy((p) => ({ ...p, [busyKey]: false }));
        }
    };

    // 区域2 一键生成：为所有资产生成「基础形象」
    const generateAllBase = async () => {
        setBulkRunning(true);
        try {
            for (const a of assets) {
                if (!a.prompt?.trim()) continue;
                const run = await runPurpose(imagePurpose, { prompt: a.prompt, params: { size, quality, idPrefix: CAT_PREFIX[cat], assetName: a.name } });
                if (run.status === "success" && run.resultUri) addAssetImage(cat, a.id, null, run.resultUri, true);
            }
            await useProjectStore.getState().save(true);
        } catch (err) {
            console.error(err);
            alert(`批量生成失败：${err instanceof Error ? err.message : "未知错误"}`);
        } finally {
            setBulkRunning(false);
        }
    };

    // 区域3 一键生成：为当前资产的所有造型（基础+变体）各生成一张
    const generateAllForms = async () => {
        if (!activeAsset) return;
        for (const f of forms) {
            if (f.prompt.trim()) await generateForm(activeAsset.id, f, 1);
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
            const instruction = [
                "你是 AI 出图提示词工程师。请在不改变资产身份与 DNA 的前提下，润色优化下面这段【出图提示词】，",
                "使其更精确、更利于 3D/国漫风格出图：补全画质/构图/光影/镜头细节，保留纯白背景与禁止红线，",
                "不要新增剧情动作或无关元素。只输出优化后的提示词正文，不要任何解释。",
                "",
                "【原提示词】：",
                activeForm.prompt,
            ].join("\n");
            const run = await runPurpose("script.analyze", { prompt: instruction, params: { temperature: 0.6, maxTokens: 2048 } });
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

    const busyKey = activeForm ? `${activeAsset?.id}:${activeForm.key}` : "";

    return (
        <div style={{ flex: 1, minWidth: 0, display: "flex", gap: 10, padding: "10px 10px 10px 0", height: "100%", boxSizing: "border-box" }}>

            {/* 区域2：资产列表（不变） */}
            <div style={{ width: 230, display: "flex", flexDirection: "column", gap: 10, ...panel, padding: 10 }}>
                <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between" }}>
                    <span style={{ fontSize: 13, fontWeight: 600, color: "#fff" }}>{unit}列表</span>
                    <div style={{ display: "flex", gap: 10, fontSize: 11 }}>
                        <span onClick={() => !bulkRunning && generateAllBase()} style={{ color: bulkRunning ? "#a78bfa" : "rgba(255,255,255,0.6)", cursor: "pointer" }}>{bulkRunning ? "生成中…" : "一键生成"}</span>
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
                        const isBusy = busy[`${activeAsset.id}:${f.key}`];
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
                            <div style={{ display: "flex", gap: 8 }}>
                                <label style={{ flex: "0 0 64px" }}>
                                    <div style={{ fontSize: 10, color: "rgba(255,255,255,0.45)", marginBottom: 2 }}>数量</div>
                                    <select value={genCount} onChange={(e) => setGenCount(Number(e.target.value))}
                                        style={{ width: "100%", ...panel, color: "#fff", fontSize: 11, padding: "6px 6px", outline: "none" }}>
                                        {GEN_COUNTS.map((n) => <option key={n} value={n} style={{ background: "#1f1f2e" }}>{n}</option>)}
                                    </select>
                                </label>
                                <label style={{ flex: "0 0 84px" }}>
                                    <div style={{ fontSize: 10, color: "rgba(255,255,255,0.45)", marginBottom: 2 }}>质量</div>
                                    <select value={quality} onChange={(e) => setQuality(e.target.value)}
                                        style={{ width: "100%", ...panel, color: "#fff", fontSize: 11, padding: "6px 6px", outline: "none" }}>
                                        {QUALITIES.map((q) => <option key={q} value={q} style={{ background: "#1f1f2e" }}>{q}</option>)}
                                    </select>
                                </label>
                                <label style={{ flex: 1, minWidth: 0 }}>
                                    <div style={{ fontSize: 10, color: "rgba(255,255,255,0.45)", marginBottom: 2 }}>比例 / 分辨率</div>
                                    <select value={size} onChange={(e) => setSize(e.target.value)}
                                        style={{ width: "100%", ...panel, color: "#fff", fontSize: 11, padding: "6px 6px", outline: "none" }}>
                                        {SIZES.map((s) => <option key={s.v} value={s.v} style={{ background: "#1f1f2e" }}>{s.label}</option>)}
                                    </select>
                                </label>
                            </div>
                        </div>

                        <div style={{ display: "flex", gap: 10 }}>
                            <button onClick={() => activeAsset && generateForm(activeAsset.id, activeForm, genCount)} disabled={!!busy[busyKey]}
                                style={{ flex: 1, padding: "9px 0", background: accent, color: "#fff", border: "none", borderRadius: 6, cursor: busy[busyKey] ? "not-allowed" : "pointer", opacity: busy[busyKey] ? 0.7 : 1, fontSize: 12 }}>
                                {busy[busyKey] ? "生成中…" : "生成形象"}
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
                <div style={{ fontSize: 13, fontWeight: 600, color: "#fff" }}>图片展示{activeForm ? `　·　${activeForm.title}（${activeForm.label}）` : ""}</div>
                {!activeForm ? (
                    <div style={{ flex: 1, display: "flex", alignItems: "center", justifyContent: "center", color: "rgba(255,255,255,0.4)", fontSize: 12 }}>请选择左侧造型</div>
                ) : (
                    <>
                        <div style={{ flex: 1, minHeight: 0, borderRadius: 8, background: activeForm.image ? `center/contain no-repeat url(${activeForm.image})` : "rgba(255,255,255,0.04)", display: "flex", alignItems: "center", justifyContent: "center", color: "rgba(255,255,255,0.35)", fontSize: 13 }}>
                            {!activeForm.image && "暂无图片，点击「生成形象」"}
                        </div>
                        <div>
                            <div style={{ fontSize: 11, color: "rgba(255,255,255,0.5)", marginBottom: 6 }}>历史记录（点击设为主图，绑定资产时使用主图）</div>
                            <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
                                {activeForm.images.length === 0 ? (
                                    <span style={{ color: "rgba(255,255,255,0.3)", fontSize: 12 }}>暂无历史</span>
                                ) : activeForm.images.map((uri, i) => {
                                    const isMain = uri === activeForm.image;
                                    return (
                                        <div key={i} onClick={() => activeAsset && setAssetMainImage(cat, activeAsset.id, activeForm.variantId, uri)}
                                            title={isMain ? "当前主图" : "设为主图"}
                                            style={{ width: 64, height: 64, borderRadius: 6, cursor: "pointer", background: `center/cover no-repeat url(${uri})`, border: isMain ? `2px solid ${accent}` : "2px solid transparent", boxShadow: isMain ? "0 0 0 1px rgba(139,92,246,0.4)" : "none" }} />
                                    );
                                })}
                            </div>
                        </div>
                    </>
                )}
            </div>
        </div>
    );
};

export default AssetWorkbench;
