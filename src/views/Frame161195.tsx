import { useEffect, useMemo, useState } from "react";
import EditorHeader from "@/components/EditorHeader";
import EditorSidebar from "@/components/EditorSidebar";
import { useProjectStore } from "@/store/projectStore";
import { runPurpose } from "@/services/purposeRunner";
import type { ShotMaterial, StoryboardShot } from "@/services/projectFile";
import "@/styles/Frame161195.css";

// ── 工具：本地图片压缩为缩略图 dataURL ──
async function fileToThumb(file: File, maxSize = 512): Promise<string> {
    return new Promise((resolve, reject) => {
        const r = new FileReader();
        r.onload = () => {
            const img = new Image();
            img.onload = () => {
                let { width: w, height: h } = img;
                if (w >= h && w > maxSize) { h = Math.round(h * maxSize / w); w = maxSize; }
                else if (h > w && h > maxSize) { w = Math.round(w * maxSize / h); h = maxSize; }
                const c = document.createElement("canvas");
                c.width = w; c.height = h;
                const ctx = c.getContext("2d");
                if (!ctx) { reject(new Error("no ctx")); return; }
                ctx.drawImage(img, 0, 0, w, h);
                resolve(c.toDataURL("image/webp", 0.85));
            };
            img.onerror = reject;
            img.src = r.result as string;
        };
        r.onerror = reject;
        r.readAsDataURL(file);
    });
}

// ── 解析「开始分镜」LLM 输出为分镜数组（只认模型真实产出，不编造） ──
function parseShots(text: string): StoryboardShot[] {
    const mk = (index: number, prompt: string, title?: string): StoryboardShot => ({
        id: `shot-${Date.now()}-${index}-${Math.floor(Math.random() * 1000)}`,
        index,
        title: title || `分镜${index}`,
        prompt: prompt.trim(),
        materials: [],
    });

    // 1) 优先解析 JSON（storyboard.v1：{ shots:[{index,plot,dialogue,dynamicVideoPrompt,durationSec}] }）
    const jsonStr = (() => {
        const t = text.trim();
        if (t.startsWith("{") || t.startsWith("[")) return t;
        const a = t.indexOf("{"); const b = t.lastIndexOf("}");
        return a >= 0 && b > a ? t.slice(a, b + 1) : "";
    })();
    if (jsonStr) {
        try {
            const obj = JSON.parse(jsonStr);
            const shots = Array.isArray(obj) ? obj : obj.shots;
            if (Array.isArray(shots) && shots.length > 0) {
                return shots.map((s: any, i: number) =>
                    mk(
                        Number(s.index) || i + 1,
                        String(s.dynamicVideoPrompt || s.prompt || s.plot || "").trim(),
                        s.title,
                    ),
                );
            }
        } catch {
            /* 落到文本解析 */
        }
    }

    // 2) 文本解析：按「分镜N」/编号分块
    const blocks = text.split(/\n(?=\s*(?:分镜|镜头|shot)\s*\d+|^\s*\d+[.、])/i).map((b) => b.trim()).filter(Boolean);
    if (blocks.length > 1) {
        return blocks.map((b, i) => mk(i + 1, b.replace(/^\s*(?:分镜|镜头|shot)?\s*\d+[.、:：]?/i, "").trim()));
    }
    return [];
}

// ── 富文本：把提示词里命中的资产名渲染成 @缩略图胶囊 ──
function renderRichPrompt(prompt: string, materials: ShotMaterial[]): React.ReactNode {
    const named = materials.filter((m) => m.name).sort((a, b) => b.name.length - a.name.length);
    if (named.length === 0) return prompt;
    const nodes: React.ReactNode[] = [];
    let rest = prompt;
    let guard = 0;
    while (rest.length > 0 && guard++ < 500) {
        // 找最早出现的资产名
        let hitIdx = -1; let hit: ShotMaterial | null = null;
        for (const m of named) {
            const idx = rest.indexOf(m.name);
            if (idx >= 0 && (hitIdx === -1 || idx < hitIdx)) { hitIdx = idx; hit = m; }
        }
        if (hitIdx === -1 || !hit) { nodes.push(rest); break; }
        if (hitIdx > 0) nodes.push(rest.slice(0, hitIdx));
        nodes.push(
            <span key={`${hit.id}-${nodes.length}`} className="sb-mention" title={hit.name}>
                {hit.uri && <img src={hit.uri} alt={hit.name} />}@{hit.name}
            </span>,
        );
        rest = rest.slice(hitIdx + hit.name.length);
    }
    return nodes;
}

const KIND_LABEL: Record<string, string> = {
    character: "角色", scene: "场景", creature: "生物", prop: "道具", local: "本地",
};

// 故事板提示词模板（基座）：故事板 = 图片素材 + 故事板提示词 + 分镜提示词 三方共同生成。
// 这里先留空占位，后续接管理端/catalog 的「故事板」模板正文；用 {{分镜提示词}} 占位接入分镜提示词。
const STORYBOARD_PROMPT_TEMPLATE = "";
function composeStoryboardPrompt(shotPrompt: string): string {
    if (STORYBOARD_PROMPT_TEMPLATE.trim()) {
        return STORYBOARD_PROMPT_TEMPLATE.includes("{{分镜提示词}}")
            ? STORYBOARD_PROMPT_TEMPLATE.replace(/{{分镜提示词}}/g, shotPrompt)
            : `${STORYBOARD_PROMPT_TEMPLATE.trim()}\n\n${shotPrompt}`;
    }
    return shotPrompt;
}

const Frame161195 = () => {
    const episodes = useProjectStore((s) => s.episodes);
    const visualStyle = useProjectStore((s) => s.visualStyle) || "国漫电影感";
    const characters = useProjectStore((s) => s.characters);
    const scenes = useProjectStore((s) => s.scenes);
    const items = useProjectStore((s) => s.items);
    const organisms = useProjectStore((s) => s.organisms);

    const [selectedId, setSelectedId] = useState<string | null>(null);
    const [maxDuration, setMaxDuration] = useState(15);
    const [shotCount, setShotCount] = useState(20);
    const [busy, setBusy] = useState<Record<string, boolean>>({});
    const [zoomUri, setZoomUri] = useState<string | null>(null);
    const [addingShotId, setAddingShotId] = useState<string | null>(null); // 哪个分镜在加素材
    const [editingPromptId, setEditingPromptId] = useState<string | null>(null);

    useEffect(() => {
        if (episodes.length > 0 && !selectedId) setSelectedId(episodes[0].id);
    }, [episodes, selectedId]);

    const activeEp = episodes.find((e) => e.id === selectedId) || null;

    // 资产池（用于匹配素材）
    const assetPool = useMemo(() => {
        const pool: { kind: ShotMaterial["kind"]; name: string; uri: string; assetId: string }[] = [];
        for (const c of characters) pool.push({ kind: "character", name: c.name, uri: c.image || "", assetId: c.id });
        for (const s of scenes) pool.push({ kind: "scene", name: s.name, uri: s.image || "", assetId: s.id });
        for (const o of organisms) pool.push({ kind: "creature", name: o.name, uri: o.image || "", assetId: o.id });
        for (const i of items) pool.push({ kind: "prop", name: i.name, uri: i.image || "", assetId: i.id });
        return pool.filter((p) => p.name);
    }, [characters, scenes, items, organisms]);

    const setFlag = (k: string, v: boolean) => setBusy((p) => ({ ...p, [k]: v }));

    // 1. 新建分集
    const handleAddEpisode = () => {
        const id = useProjectStore.getState().addEpisode();
        setSelectedId(id);
    };

    // 2. 开始分镜（文本模型）
    const handleSplit = async () => {
        if (!activeEp) { alert("请先在左侧选择或新建分集"); return; }
        if (!activeEp.scriptText.trim()) { alert("请先填写本集剧本内容"); return; }
        setFlag(`split-${activeEp.id}`, true);
        try {
            const prompt = [
                `请把下面这一集剧本拆分为分镜。要求：约 ${shotCount} 个分镜，每个分镜时长不超过 ${maxDuration} 秒。`,
                `每个分镜给出：画面/动态视频提示词（用于AI视频生成）。视觉风格：${visualStyle}。`,
                "",
                "本集剧本：",
                activeEp.scriptText,
            ].join("\n");
            // 不强制结构化输出（避免上游不返回合法 JSON 时硬失败）；parseShots 同时兼容 JSON 与文本
            const run = await runPurpose("storyboard.split", {
                prompt,
                params: { maxDurationSec: maxDuration, shotCount },
                onProgress: () => {},
            });
            if (run.status === "no_model") throw new Error("未配置可用的文本模型，请先在「设置 → 模型」中选择后重试。");
            if (run.status === "failed") throw new Error(run.error || "分镜失败");
            const shots = parseShots(run.resultUri || "");
            if (shots.length === 0) throw new Error("未能从模型输出解析出分镜，请重试或调整剧本。");
            useProjectStore.getState().setEpisodeShots(activeEp.id, shots);
            await useProjectStore.getState().save(true);
        } catch (err) {
            alert(`分镜失败：${err instanceof Error ? err.message : "未知错误"}`);
        } finally {
            setFlag(`split-${activeEp.id}`, false);
        }
    };

    // 3. 匹配素材（按分镜提示词扫描资产名，本地确定性匹配）
    const handleMatch = (shot: StoryboardShot) => {
        if (!activeEp) return;
        const seen = new Set(shot.materials.map((m) => m.assetId || m.name));
        const matched: ShotMaterial[] = [...shot.materials];
        for (const a of assetPool) {
            if (shot.prompt.includes(a.name) && !seen.has(a.assetId)) {
                seen.add(a.assetId);
                matched.push({ id: `mat-${Date.now()}-${Math.floor(Math.random() * 1e6)}`, assetId: a.assetId, kind: a.kind, name: a.name, uri: a.uri });
            }
        }
        if (matched.length === shot.materials.length) {
            alert("未在该分镜提示词中匹配到任何已有资产（角色/场景/生物/道具）。");
            return;
        }
        useProjectStore.getState().updateShot(activeEp.id, shot.id, { materials: matched });
    };

    // 4. 故事板生成（图像模型）
    const handleStoryboard = async (shot: StoryboardShot) => {
        if (!activeEp) return;
        setFlag(`sb-${shot.id}`, true);
        try {
            // 故事板 = 图片素材 + 故事板提示词模板 + 分镜提示词 → 图像模型
            const materialImages = shot.materials.filter((m) => m.uri).map((m) => ({ url: m.uri }));
            const finalPrompt = composeStoryboardPrompt(shot.prompt);
            const run = await runPurpose("asset.scene.image", {
                prompt: finalPrompt,
                input: materialImages.length ? { images: materialImages } : undefined,
                params: { size: "1024x1024", quality: "standard" },
            });
            if (run.status === "no_model") throw new Error("未配置可用的图像模型，请先在「设置 → 模型」中选择后重试。");
            if (run.status === "failed") throw new Error(run.error || "生成失败");
            useProjectStore.getState().updateShot(activeEp.id, shot.id, { storyboardUri: run.resultUri });
            await useProjectStore.getState().save(true);
        } catch (err) {
            alert(`故事板生成失败：${err instanceof Error ? err.message : "未知错误"}`);
        } finally {
            setFlag(`sb-${shot.id}`, false);
        }
    };

    // 5. 视频生成（视频模型）
    const handleVideo = async (shot: StoryboardShot) => {
        if (!activeEp) return;
        setFlag(`vid-${shot.id}`, true);
        try {
            const images = shot.storyboardUri ? { images: [{ url: shot.storyboardUri }] } : undefined;
            const run = await runPurpose("video.generate", {
                prompt: shot.prompt,
                params: { duration: maxDuration, aspect_ratio: "9:16" },
                input: images,
            });
            if (run.status === "no_model") throw new Error("未配置可用的视频模型，请先在「设置 → 模型」中选择后重试。");
            if (run.status === "failed") throw new Error(run.error || "生成失败");
            useProjectStore.getState().updateShot(activeEp.id, shot.id, { videoUri: run.resultUri });
            await useProjectStore.getState().save(true);
        } catch (err) {
            alert(`视频生成失败：${err instanceof Error ? err.message : "未知错误"}`);
        } finally {
            setFlag(`vid-${shot.id}`, false);
        }
    };

    // 素材：右击删除
    const removeMaterial = (shot: StoryboardShot, matId: string) => {
        if (!activeEp) return;
        useProjectStore.getState().updateShot(activeEp.id, shot.id, {
            materials: shot.materials.filter((m) => m.id !== matId),
        });
    };
    // 素材：从资产库添加
    const addAssetMaterial = (shot: StoryboardShot, a: { kind: ShotMaterial["kind"]; name: string; uri: string; assetId: string }) => {
        if (!activeEp) return;
        if (shot.materials.some((m) => m.assetId === a.assetId)) { setAddingShotId(null); return; }
        useProjectStore.getState().updateShot(activeEp.id, shot.id, {
            materials: [...shot.materials, { id: `mat-${Date.now()}-${Math.floor(Math.random() * 1e6)}`, assetId: a.assetId, kind: a.kind, name: a.name, uri: a.uri }],
        });
        setAddingShotId(null);
    };
    // 素材：本地上传
    const addLocalMaterial = async (shot: StoryboardShot, file: File) => {
        if (!activeEp) return;
        try {
            const uri = await fileToThumb(file);
            useProjectStore.getState().updateShot(activeEp.id, shot.id, {
                materials: [...shot.materials, { id: `mat-${Date.now()}-${Math.floor(Math.random() * 1e6)}`, kind: "local", name: file.name.replace(/\.[^.]+$/, ""), uri }],
            });
        } catch (e) { console.error(e); }
        setAddingShotId(null);
    };

    const cardBtn: React.CSSProperties = { padding: "5px 10px", borderRadius: 6, fontSize: 12, cursor: "pointer", border: "1px solid rgba(255,255,255,0.12)", background: "rgba(255,255,255,0.05)", color: "#fff" };

    return (
        <div className="scroll-container">
            <div id="16_1195" className="Pixso-frame-16_1195">
                <EditorHeader title="分镜配置" infoLabels={["默认视频模型 seedance 2.0", `画风 ${visualStyle}`, "默认视频比例 9:16"]} />
                <div style={{ display: "flex", height: "calc(100% - 56px)", overflow: "hidden" }}>
                    <EditorSidebar activeTab="视频" />

                    {/* 左：分集列表 */}
                    <div style={{ width: 220, flexShrink: 0, borderRight: "1px solid rgba(255,255,255,0.08)", display: "flex", flexDirection: "column", padding: 12, gap: 8, overflow: "hidden" }}>
                        <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between" }}>
                            <span style={{ fontWeight: 600, fontSize: 13 }}>分集列表</span>
                            <button style={cardBtn} onClick={handleAddEpisode}>+ 新建</button>
                        </div>
                        <div style={{ flex: 1, overflowY: "auto", display: "flex", flexDirection: "column", gap: 6 }}>
                            {episodes.length === 0 ? (
                                <div style={{ color: "var(--muted-foreground)", fontSize: 12, padding: "24px 8px", textAlign: "center" }}>
                                    暂无分集。点「新建」添加，或先在「剧本」里完成拆分。
                                </div>
                            ) : (
                                episodes.map((ep) => (
                                    <div
                                        key={ep.id}
                                        onClick={() => setSelectedId(ep.id)}
                                        style={{
                                            padding: 10, borderRadius: 8, cursor: "pointer", border: "1px solid",
                                            borderColor: ep.id === selectedId ? "rgba(139,92,246,0.6)" : "rgba(255,255,255,0.08)",
                                            background: ep.id === selectedId ? "rgba(139,92,246,0.12)" : "transparent",
                                        }}
                                    >
                                        <div style={{ fontSize: 13, fontWeight: 500 }}>{ep.title}</div>
                                        <div style={{ fontSize: 11, color: "var(--muted-foreground)", marginTop: 2 }}>
                                            {ep.shots.length > 0 ? `${ep.shots.length} 个分镜` : (ep.scriptText ? "未分镜" : "空")}
                                        </div>
                                    </div>
                                ))
                            )}
                        </div>
                    </div>

                    {/* 中：本集剧本 + 分镜参数 */}
                    <div style={{ width: 340, flexShrink: 0, borderRight: "1px solid rgba(255,255,255,0.08)", display: "flex", flexDirection: "column", padding: 14, gap: 12, overflow: "auto" }}>
                        <span style={{ fontWeight: 600, fontSize: 14 }}>剧本</span>
                        <textarea
                            placeholder={activeEp ? "粘贴/输入本集剧本内容" : "请先在左侧选择或新建分集"}
                            disabled={!activeEp}
                            value={activeEp?.scriptText || ""}
                            onChange={(e) => activeEp && useProjectStore.getState().updateEpisode(activeEp.id, { scriptText: e.target.value })}
                            style={{ flex: 1, minHeight: 240, resize: "none", background: "rgba(255,255,255,0.03)", border: "1px solid rgba(255,255,255,0.08)", borderRadius: 8, color: "#fff", fontSize: 13, padding: 10, outline: "none", lineHeight: 1.6 }}
                        />
                        <div style={{ display: "flex", gap: 12 }}>
                            <label style={{ flex: 1, display: "flex", flexDirection: "column", gap: 4, fontSize: 11, color: "var(--muted-foreground)" }}>
                                单分镜最大时长(秒)
                                <input type="number" value={maxDuration} min={1} max={60} onChange={(e) => setMaxDuration(Number(e.target.value) || 15)}
                                    style={{ background: "rgba(255,255,255,0.05)", border: "1px solid rgba(255,255,255,0.1)", borderRadius: 6, color: "#fff", padding: "6px 8px", fontSize: 13 }} />
                            </label>
                            <label style={{ flex: 1, display: "flex", flexDirection: "column", gap: 4, fontSize: 11, color: "var(--muted-foreground)" }}>
                                需要分成多少分镜
                                <input type="number" value={shotCount} min={1} max={200} onChange={(e) => setShotCount(Number(e.target.value) || 20)}
                                    style={{ background: "rgba(255,255,255,0.05)", border: "1px solid rgba(255,255,255,0.1)", borderRadius: 6, color: "#fff", padding: "6px 8px", fontSize: 13 }} />
                            </label>
                        </div>
                        <button
                            onClick={handleSplit}
                            disabled={!activeEp || busy[`split-${activeEp?.id}`]}
                            style={{ padding: "10px", borderRadius: 8, border: "none", cursor: activeEp ? "pointer" : "not-allowed", background: "linear-gradient(90deg,#8b5cf6,#7c3aed)", color: "#fff", fontWeight: 600, fontSize: 13, opacity: activeEp ? 1 : 0.5 }}
                        >
                            {activeEp && busy[`split-${activeEp.id}`] ? "分镜中…" : "开始分镜"}
                        </button>
                    </div>

                    {/* 右：分镜列表 */}
                    <div style={{ flex: 1, overflowY: "auto", padding: 16, display: "flex", flexDirection: "column", gap: 14 }}>
                        {!activeEp ? (
                            <div style={{ color: "var(--muted-foreground)", fontSize: 13, margin: "auto" }}>请选择分集</div>
                        ) : activeEp.shots.length === 0 ? (
                            <div style={{ color: "var(--muted-foreground)", fontSize: 13, margin: "auto" }}>尚无分镜，点中间「开始分镜」生成。</div>
                        ) : (
                            activeEp.shots.map((shot) => (
                                <div key={shot.id} style={{ display: "flex", gap: 14, border: "1px solid rgba(255,255,255,0.08)", borderRadius: 10, padding: 12, background: "rgba(255,255,255,0.02)" }}>
                                    {/* 素材区 */}
                                    <div style={{ width: 150, flexShrink: 0, display: "flex", flexDirection: "column", gap: 6 }}>
                                        <span style={{ fontSize: 11, color: "var(--muted-foreground)" }}>垫素材</span>
                                        <div style={{ display: "flex", flexWrap: "wrap", gap: 6 }}>
                                            {shot.materials.map((m) => (
                                                <div
                                                    key={m.id}
                                                    title={`${KIND_LABEL[m.kind]}·${m.name}（双击放大 / 右键删除）`}
                                                    onDoubleClick={() => m.uri && setZoomUri(m.uri)}
                                                    onContextMenu={(e) => { e.preventDefault(); if (confirm(`删除素材「${m.name}」？`)) removeMaterial(shot, m.id); }}
                                                    style={{ width: 42, height: 42, borderRadius: 6, overflow: "hidden", border: "1px solid rgba(255,255,255,0.12)", background: "rgba(255,255,255,0.05)", cursor: m.uri ? "zoom-in" : "default", display: "flex", alignItems: "center", justifyContent: "center", fontSize: 9, color: "var(--muted-foreground)", textAlign: "center" }}
                                                >
                                                    {m.uri ? <img src={m.uri} alt={m.name} style={{ width: "100%", height: "100%", objectFit: "cover" }} /> : m.name.slice(0, 4)}
                                                </div>
                                            ))}
                                            {/* + 添加 */}
                                            <button
                                                onClick={() => setAddingShotId(addingShotId === shot.id ? null : shot.id)}
                                                style={{ width: 42, height: 42, borderRadius: 6, border: "1px dashed rgba(255,255,255,0.25)", background: "transparent", color: "var(--muted-foreground)", cursor: "pointer", fontSize: 18 }}
                                            >+</button>
                                        </div>
                                        {addingShotId === shot.id && (
                                            <div style={{ border: "1px solid rgba(255,255,255,0.12)", borderRadius: 8, padding: 8, background: "#161b26", maxHeight: 220, overflowY: "auto" }}>
                                                <label style={{ ...cardBtn, display: "block", textAlign: "center", marginBottom: 6 }}>
                                                    本地上传
                                                    <input type="file" accept="image/*" style={{ display: "none" }} onChange={(e) => { const f = e.target.files?.[0]; if (f) addLocalMaterial(shot, f); e.target.value = ""; }} />
                                                </label>
                                                {assetPool.length === 0 ? (
                                                    <div style={{ fontSize: 11, color: "var(--muted-foreground)" }}>资产库为空</div>
                                                ) : assetPool.map((a) => (
                                                    <div key={a.assetId} onClick={() => addAssetMaterial(shot, a)} style={{ display: "flex", alignItems: "center", gap: 6, padding: "4px 6px", borderRadius: 6, cursor: "pointer", fontSize: 12 }}
                                                        onMouseEnter={(e) => (e.currentTarget.style.background = "rgba(255,255,255,0.06)")}
                                                        onMouseLeave={(e) => (e.currentTarget.style.background = "transparent")}>
                                                        <span style={{ width: 24, height: 24, borderRadius: 4, overflow: "hidden", background: "rgba(255,255,255,0.08)", flexShrink: 0, display: "inline-flex", alignItems: "center", justifyContent: "center", fontSize: 8 }}>
                                                            {a.uri ? <img src={a.uri} style={{ width: "100%", height: "100%", objectFit: "cover" }} /> : KIND_LABEL[a.kind]}
                                                        </span>
                                                        <span style={{ color: "var(--muted-foreground)" }}>[{KIND_LABEL[a.kind]}]</span>{a.name}
                                                    </div>
                                                ))}
                                            </div>
                                        )}
                                    </div>

                                    {/* 结果区（故事板/视频） */}
                                    <div style={{ width: 160, flexShrink: 0, borderRadius: 8, border: "1px solid rgba(255,255,255,0.1)", background: "rgba(0,0,0,0.25)", display: "flex", alignItems: "center", justifyContent: "center", overflow: "hidden", minHeight: 120 }}>
                                        {shot.videoUri ? (
                                            <video src={shot.videoUri} controls style={{ width: "100%", maxHeight: 180 }} />
                                        ) : shot.storyboardUri ? (
                                            <img src={shot.storyboardUri} alt={shot.title} onDoubleClick={() => setZoomUri(shot.storyboardUri!)} style={{ width: "100%", height: "100%", objectFit: "cover", cursor: "zoom-in" }} />
                                        ) : (
                                            <span style={{ color: "var(--muted-foreground)", fontSize: 12 }}>{busy[`sb-${shot.id}`] || busy[`vid-${shot.id}`] ? "生成中…" : "待生成"}</span>
                                        )}
                                    </div>

                                    {/* 提示词 + 操作 */}
                                    <div style={{ flex: 1, display: "flex", flexDirection: "column", gap: 8, minWidth: 0 }}>
                                        <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
                                            <span style={{ fontWeight: 600, fontSize: 13 }}>{shot.title}</span>
                                            <button style={{ ...cardBtn, padding: "2px 8px", fontSize: 11 }} onClick={() => setEditingPromptId(editingPromptId === shot.id ? null : shot.id)}>
                                                {editingPromptId === shot.id ? "完成" : "编辑提示词"}
                                            </button>
                                        </div>
                                        {editingPromptId === shot.id ? (
                                            <textarea
                                                value={shot.prompt}
                                                onChange={(e) => useProjectStore.getState().updateShot(activeEp.id, shot.id, { prompt: e.target.value })}
                                                style={{ minHeight: 80, resize: "vertical", background: "rgba(255,255,255,0.03)", border: "1px solid rgba(255,255,255,0.1)", borderRadius: 6, color: "#fff", fontSize: 12, padding: 8, outline: "none", lineHeight: 1.6 }}
                                            />
                                        ) : (
                                            <div style={{ fontSize: 12, color: "#d6d6dd", lineHeight: 1.7, whiteSpace: "pre-wrap" }}>
                                                {renderRichPrompt(shot.prompt, shot.materials)}
                                            </div>
                                        )}
                                        <div style={{ display: "flex", gap: 8, marginTop: "auto", flexWrap: "wrap" }}>
                                            <button style={cardBtn} onClick={() => handleMatch(shot)}>匹配素材</button>
                                            <button style={cardBtn} disabled={busy[`sb-${shot.id}`]} onClick={() => handleStoryboard(shot)}>{busy[`sb-${shot.id}`] ? "生成中…" : "故事板生成"}</button>
                                            <button style={cardBtn} disabled={busy[`vid-${shot.id}`]} onClick={() => handleVideo(shot)}>{busy[`vid-${shot.id}`] ? "生成中…" : "视频生成"}</button>
                                        </div>
                                    </div>
                                </div>
                            ))
                        )}
                    </div>
                </div>
            </div>

            {/* 缩略图放大：单击关闭 */}
            {zoomUri && (
                <div onClick={() => setZoomUri(null)} style={{ position: "fixed", inset: 0, zIndex: 30000, background: "rgba(0,0,0,0.8)", display: "flex", alignItems: "center", justifyContent: "center", cursor: "zoom-out" }}>
                    <img src={zoomUri} alt="放大" style={{ maxWidth: "90vw", maxHeight: "90vh", borderRadius: 8 }} />
                </div>
            )}
        </div>
    );
};

export default Frame161195;
