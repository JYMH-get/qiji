import { useState, useEffect } from "react";
import EditorHeader from "@/components/EditorHeader";
import EditorSidebar from "@/components/EditorSidebar";
import { useProjectStore } from "@/store/projectStore";
import { runPurpose } from "@/services/purposeRunner";
import "@/styles/Frame1693.css";

// @ts-ignore
import defaultPromptTemplate from "../../skills/小说2资产/资产拆分.md?raw";

// Helper formatters for template variables
function formatCharactersForTemplate(characters: any[]) {
    if (!characters || characters.length === 0) return "无角色数据";
    return characters.map((c, index) => 
        `角色 ${index + 1}: ${c.name}\n- 核心特征:\n${c.features || "无"}\n- 设计理念:\n${c.philosophy || "无"}\n- 三视图提示词:\n${c.prompt || "无"}`
    ).join("\n\n---\n\n");
}

function formatScenesForTemplate(scenes: any[]) {
    if (!scenes || scenes.length === 0) return "无场景数据";
    return scenes.map((s, index) => 
        `场景 ${index + 1}: ${s.name}\n- 描述:\n${s.description || "无"}\n- 设计理念:\n${s.philosophy || "无"}\n- 场景提示词:\n${s.prompt || "无"}`
    ).join("\n\n---\n\n");
}

function formatItemsForTemplate(items: any[]) {
    if (!items || items.length === 0) return "无物品/道具数据";
    return items.map((i, index) => 
        `物品 ${index + 1}: ${i.name}\n- 描述:\n${i.description || "无"}\n- 设计理念:\n${i.philosophy || "无"}\n- 物品提示词:\n${i.prompt || "无"}`
    ).join("\n\n---\n\n");
}

function formatOrganismsForTemplate(organisms: any[]) {
    if (!organisms || organisms.length === 0) return "无生物数据";
    return organisms.map((o, index) => 
        `生物 ${index + 1}: ${o.name}\n- 描述:\n${o.description || "无"}\n- 设计理念:\n${o.philosophy || "无"}\n- 生物提示词:\n${o.prompt || "无"}`
    ).join("\n\n---\n\n");
}

function compileTemplate(template: string, data: {
    projectName: string;
    scriptText: string;
    visualStyle: string;
    characters: any[];
    scenes: any[];
    items: any[];
    organisms: any[];
}) {
    const now = new Date();
    const currentTimeStr = `${now.getFullYear()}/${String(now.getMonth() + 1).padStart(2, "0")}/${String(now.getDate()).padStart(2, "0")} ${String(now.getHours()).padStart(2, "0")}:${String(now.getMinutes()).padStart(2, "0")}:${String(now.getSeconds()).padStart(2, "0")}`;

    const charFormatted = formatCharactersForTemplate(data.characters);
    const sceneFormatted = formatScenesForTemplate(data.scenes);
    const itemFormatted = formatItemsForTemplate(data.items);
    const organismFormatted = formatOrganismsForTemplate(data.organisms);

    return template
        .replace(/{{项目}}/g, () => data.projectName)
        .replace(/{{项目名称}}/g, () => data.projectName)
        .replace(/{{原文}}/g, () => data.scriptText)
        .replace(/{{小说原文}}/g, () => data.scriptText)
        .replace(/{{剧本原文}}/g, () => data.scriptText)
        .replace(/{{视觉风格}}/g, () => data.visualStyle)
        .replace(/{{角色列表}}/g, () => charFormatted)
        .replace(/{{场景列表}}/g, () => sceneFormatted)
        .replace(/{{物品列表}}/g, () => itemFormatted)
        .replace(/{{道具列表}}/g, () => itemFormatted)
        .replace(/{{生物列表}}/g, () => organismFormatted)
        .replace(/{{当前时间}}/g, () => currentTimeStr)
        .replace(/{{日期}}/g, () => currentTimeStr)
        .replace(/{{时间}}/g, () => currentTimeStr);
}

// 从可能夹带散文的 LLM 文本里抠出第一个完整 JSON 对象（按花括号配平），失败返回 null
function extractJsonObject(text: string): any | null {
    const t = (text || "").trim();
    // 优先 ```json 代码块
    const fence = t.match(/```(?:json)?\s*([\s\S]*?)```/i);
    const candidates: string[] = [];
    if (fence) candidates.push(fence[1].trim());
    // 花括号配平扫描（容忍字符串内的括号与转义）
    const start = t.indexOf("{");
    if (start >= 0) {
        let depth = 0, inStr = false, esc = false;
        for (let i = start; i < t.length; i++) {
            const ch = t[i];
            if (inStr) {
                if (esc) esc = false;
                else if (ch === "\\") esc = true;
                else if (ch === '"') inStr = false;
            } else if (ch === '"') inStr = true;
            else if (ch === "{") depth++;
            else if (ch === "}") { depth--; if (depth === 0) { candidates.push(t.slice(start, i + 1)); break; } }
        }
    }
    for (const c of candidates) {
        try { return JSON.parse(c); } catch { /* 试下一个候选 */ }
    }
    return null;
}

type ParsedAsset = { id: string; name: string; features: string; philosophy: string; prompt: string; image?: string; variants: any[] };

// 解析资产提取 LLM 输出（asset.extract.v1）：按 C/A/G/M/S/P 编号前缀分流到 角色/场景/生物/物品，变体折叠进父资产。
// 兼容两种结构：扁平 assets[]（带 id/type/prompt）与嵌套 characters[]/scenes[]/creatures[]/props[]。
function parseAssetExtraction(text: string): {
    characters: ParsedAsset[]; scenes: ParsedAsset[]; items: ParsedAsset[]; organisms: ParsedAsset[]; crowds: ParsedAsset[];
} {
    const empty = { characters: [] as ParsedAsset[], scenes: [] as ParsedAsset[], items: [] as ParsedAsset[], organisms: [] as ParsedAsset[], crowds: [] as ParsedAsset[] };
    const root = extractJsonObject(text);
    if (!root) return empty;

    // 统一成一个扁平 assets 列表
    const flat: any[] = [];
    if (Array.isArray(root.assets)) {
        flat.push(...root.assets);
    } else {
        const push = (arr: any, cat: string) => Array.isArray(arr) && arr.forEach((a) => {
            flat.push({ ...a, category: a.category || cat });
            (a.variants || []).forEach((v: any) => flat.push({ ...v, category: a.category || cat, inheritsFrom: v.inheritsFrom || v.inherits_from || a.code || a.id }));
        });
        push(root.characters, "character"); push(root.scenes, "scene");
        push(root.creatures, "creature"); push(root.props, "prop");
    }
    if (flat.length === 0) return empty;

    const ts = Date.now();
    let n = 0;
    const codeOf = (a: any) => String(a.id || a.code || "").trim();
    const parentCode = (code: string) => (code.match(/^([A-Za-z]+\d+)/) || [])[1] || code;
    const isVariant = (a: any) => {
        const c = codeOf(a);
        return !!(a.inheritsFrom || a.inherits_from) || /^[A-Za-z]+\d+[A-Za-z]+$/.test(c) || /variant/i.test(String(a.type || ""));
    };
    // 编号前缀 / type / category → 四大类
    const bucketOf = (a: any): keyof typeof buckets => {
        const c = codeOf(a).toUpperCase();
        const head = c[0];
        if (head === "S") return "scenes";
        if (head === "M") return "organisms";
        if (head === "P") return "items";
        if (head === "G") return "crowds";       // 群像/阵营
        if (head === "C" || head === "A") return "characters";
        const cat = String(a.category || a.type || "").toLowerCase();
        if (cat.includes("scene") || cat.includes("environment")) return "scenes";
        if (cat.includes("creature") || cat.includes("monster") || cat.includes("beast")) return "organisms";
        if (cat.includes("prop") || cat.includes("item") || cat.includes("weapon")) return "items";
        if (cat.includes("group") || cat.includes("crowd") || cat.includes("ensemble")) return "crowds";
        return "characters";
    };
    const buckets = { characters: [] as ParsedAsset[], scenes: [] as ParsedAsset[], items: [] as ParsedAsset[], organisms: [] as ParsedAsset[], crowds: [] as ParsedAsset[] };
    const byCode: Record<string, ParsedAsset> = {};

    // 先建基础资产
    for (const a of flat) {
        if (isVariant(a)) continue;
        const code = codeOf(a);
        const asset: ParsedAsset = {
            id: `${code || "asset"}-${ts}-${++n}`,
            name: String(a.name || a.title || code || "未命名资产").trim(),
            features: String(a.reason || a.status || "").trim(),
            philosophy: "",
            prompt: String(a.prompt || a.imagePrompt || a.image_prompt || "").trim(),
            image: undefined,
            variants: [],
        };
        buckets[bucketOf(a)].push(asset);
        if (code) byCode[parentCode(code).toUpperCase()] = asset;
    }
    // 再把变体折叠进父资产（找不到父则当独立基础资产兜底，避免丢数据）
    for (const a of flat) {
        if (!isVariant(a)) continue;
        const code = codeOf(a);
        const pcode = parentCode(code).toUpperCase();
        const variant = {
            id: `${code || "var"}-${ts}-${++n}`,
            label: String(a.status || a.label || "变体").trim(),
            name: String(a.name || a.title || "").trim(),
            description: String(a.reason || "").trim(),
            prompt: String(a.prompt || a.imagePrompt || a.image_prompt || "").trim(),
            image: undefined,
        };
        const parent = byCode[pcode];
        if (parent) parent.variants.push(variant);
        else buckets[bucketOf(a)].push({ id: variant.id, name: variant.name || code, features: variant.description, philosophy: "", prompt: variant.prompt, image: undefined, variants: [] });
    }
    return buckets;
}

// 解析「自动分集」LLM 输出（JSON 优先）；解析不到返回空，不编造
function parseEpisodes(text: string): Array<{ title: string; scriptText: string }> {
    const t = text.trim();
    const jsonStr = t.startsWith("[") || t.startsWith("{")
        ? t
        : (() => { const a = t.indexOf("["); const b = t.lastIndexOf("]"); return a >= 0 && b > a ? t.slice(a, b + 1) : ""; })();
    if (!jsonStr) return [];
    try {
        const parsed = JSON.parse(jsonStr);
        const list = Array.isArray(parsed) ? parsed : (parsed.episodes || []);
        return (list as any[])
            .map((e) => ({
                title: String(e.title || e.name || "").trim(),
                scriptText: String(e.scriptText || e.script || e.content || e.summary || "").trim(),
            }))
            .filter((e) => e.title || e.scriptText);
    } catch {
        return [];
    }
}

const Frame1693 = () => {
    const characters = useProjectStore((s) => s.characters);
    const scenes = useProjectStore((s) => s.scenes);
    const items = useProjectStore((s) => s.items);
    const organisms = useProjectStore((s) => s.organisms);
    const crowds = useProjectStore((s) => s.crowds);
    const isAnalyzed = useProjectStore((s) => s.isAnalyzed);
    const analysisTime = useProjectStore((s) => s.analysisTime);
    const visualStyle = useProjectStore((s) => s.visualStyle) || "国漫电影感";

    const [scriptText, setScriptText] = useState(useProjectStore.getState().scriptText || "");
    const [templates, setTemplates] = useState<string[]>(["资产拆分.md"]);
    const [selectedTemplate, setSelectedTemplate] = useState("资产拆分.md");
    const [isAnalyzing, setIsAnalyzing] = useState(false);
    const [analysisProgress, setAnalysisProgress] = useState(0);

    const storeScriptText = useProjectStore((s) => s.scriptText);
    useEffect(() => {
        setScriptText(storeScriptText);
    }, [storeScriptText]);

    // Load templates in skills/剧本/ on mount
    useEffect(() => {
        const loadTemplates = async () => {
            if (typeof window !== "undefined" && ("__TAURI_INTERNALS__" in window || "__TAURI__" in window)) {
                try {
                    const { readDir } = await import("@tauri-apps/plugin-fs");
                    const entries = await readDir("e:/Kaifa/Qiji/qiji/skills/小说2资产");
                    const mdFiles = entries
                        .filter(entry => entry.isFile && entry.name?.endsWith(".md"))
                        .map(entry => entry.name || "");
                    const validFiles = mdFiles.filter(Boolean);
                    if (validFiles.length > 0) {
                        setTemplates(validFiles);
                        // If "资产拆分.md" is not present, default to the first one
                        if (validFiles.includes("资产拆分.md")) {
                            setSelectedTemplate("资产拆分.md");
                        } else {
                            setSelectedTemplate(validFiles[0]);
                        }
                    }
                } catch (err) {
                    console.warn("Failed to read templates directory:", err);
                }
            }
        };
        loadTemplates();
    }, []);

    const handleAnalyzeScript = async () => {
        if (!scriptText.trim()) {
            alert("请输入剧本文本后再进行分析");
            return;
        }
        setIsAnalyzing(true);
        setAnalysisProgress(10);

        try {
            // Load template
            let templateText = defaultPromptTemplate;
            if (selectedTemplate !== "通用资产提取") {
                try {
                    if (typeof window !== "undefined" && ("__TAURI_INTERNALS__" in window || "__TAURI__" in window)) {
                        const { readTextFile } = await import("@tauri-apps/plugin-fs");
                        const fileText = await readTextFile(`e:/Kaifa/Qiji/qiji/skills/小说2资产/${selectedTemplate}`);
                        if (fileText && fileText.trim()) {
                            templateText = fileText;
                        }
                    }
                } catch (err) {
                    console.warn(`Failed to load prompt template ${selectedTemplate} from local fs:`, err);
                }
            }

            setAnalysisProgress(30);

            // Replace placeholders
            const compiledPrompt = compileTemplate(templateText, {
                projectName: useProjectStore.getState().name || "未命名项目",
                scriptText: scriptText,
                visualStyle: visualStyle,
                characters: useProjectStore.getState().characters || [],
                scenes: useProjectStore.getState().scenes || [],
                items: useProjectStore.getState().items || [],
                organisms: useProjectStore.getState().organisms || [],
            });

            setAnalysisProgress(50);

            // 经统一 purpose 管线提交 + 集中轮询（替代各 Frame 自建的 30×1s 轮询）
            const run = await runPurpose("script.analyze", {
                prompt: compiledPrompt,
                params: { temperature: 0.7, maxTokens: 4096 },
                onProgress: (progress, status) => {
                    if (status === "running" || status === "queued") {
                        setAnalysisProgress(Math.min(95, 50 + Math.round(progress * 0.4)));
                    }
                },
            });

            // 无兜底：没有可用模型 / 失败 → 直接报错，绝不给假数据
            if (run.status === "no_model") {
                throw new Error("未配置可用的文本模型，请先在「设置 → 模型」中选择文本模型后重试。");
            }
            if (run.status === "failed") {
                throw new Error(run.error || "LLM 提取失败");
            }

            const resultText = run.resultUri || "";
            setAnalysisProgress(85);

            if (!resultText.trim()) {
                throw new Error("模型返回为空，未提取到任何资产。");
            }

            // 解析 asset.extract.v1：按编号前缀分流到 角色/场景/生物/物品（变体折叠进父资产）。
            // 解析不到就为空，不编造（"没提取出来就没出来"）。
            const extracted = parseAssetExtraction(resultText);
            if (extracted.characters.length + extracted.scenes.length + extracted.items.length + extracted.organisms.length + extracted.crowds.length === 0) {
                throw new Error("已拿到模型返回，但未能从中解析出资产 JSON（asset.extract.v1）。请检查提示词是否要求输出该结构，或换用支持结构化输出的模型。");
            }

            const now = new Date();
            const timeString = `${now.getFullYear()}/${String(now.getMonth() + 1).padStart(2, "0")}/${String(now.getDate()).padStart(2, "0")}   ${String(now.getHours()).padStart(2, "0")}:${String(now.getMinutes()).padStart(2, "0")}`;

            useProjectStore.getState().setAnalysisResult({
                characters: extracted.characters,
                scenes: extracted.scenes,
                items: extracted.items,
                organisms: extracted.organisms,
                crowds: extracted.crowds,
                time: timeString,
            });

            // 自动分集（文本模型）：把剧本按剧情拆成分集，写入 episodes 供「视频」界面使用。
            // best-effort：失败不影响已提取的角色（视频界面仍可手动「新建分集」）。
            try {
                const epPrompt = [
                    "把下面的剧本按剧情节奏拆分成若干集（剧集）。",
                    '严格只输出 JSON 数组，每个元素为 {"title":"剧集标题","scriptText":"本集完整剧本内容"}，不要输出任何额外文字。',
                    "",
                    "剧本：",
                    scriptText,
                ].join("\n");
                const epRun = await runPurpose("script.analyze", {
                    prompt: epPrompt,
                    params: { temperature: 0.5, maxTokens: 4096 },
                });
                if (epRun.status === "success" && epRun.resultUri) {
                    const eps = parseEpisodes(epRun.resultUri);
                    if (eps.length > 0) {
                        const baseTs = Date.now();
                        useProjectStore.getState().setEpisodes(
                            eps.map((e, i) => ({
                                id: `ep-${baseTs}-${i}`,
                                index: i + 1,
                                title: `${String(i + 1).padStart(3, "0")}-${e.title || `第${i + 1}集`}`,
                                scriptText: e.scriptText,
                                shots: [],
                            })),
                        );
                    }
                }
            } catch (epErr) {
                console.warn("自动分集失败（可在视频界面手动新建分集）:", epErr);
            }

            // Auto-save project file
            await useProjectStore.getState().save(true);
            setAnalysisProgress(100);
            setTimeout(() => {
                setIsAnalyzing(false);
            }, 300);

        } catch (err) {
            console.error("Script analysis failed:", err);
            alert(`剧本分析失败：${err instanceof Error ? err.message : "未知错误"}`);
            setIsAnalyzing(false);
            setAnalysisProgress(0);
        }
    };

    return (
        <div className="scroll-container">
            <div id="16_93" className="Pixso-frame-16_93">
                <EditorHeader title="剧本配置" infoLabels={["文本模型: gpt-5.5"]} />
                <div id="16_123" className="Pixso-frame-16_123">
                    <div className="frame-content-16_123">
                        <EditorSidebar activeTab="剧本" />
                        <div id="16_175" className="Pixso-frame-16_175">
                            <div className="frame-content-16_175">
                                <div
                                    id="16_176"
                                    className="stroke-wrapper-16_176"
                                >
                                    <div className="Pixso-frame-16_176">
                                        <div className="frame-content-16_176">
                                            <div
                                                id="16_177"
                                                className="Pixso-frame-16_177"
                                            >
                                                <div className="frame-content-16_177">
                                                    <div
                                                        id="16_178"
                                                        className="Pixso-frame-16_178"
                                                    >
                                                        <div className="frame-content-16_178">
                                                            <p
                                                                id="16_179"
                                                                className="Pixso-paragraph-16_179"
                                                            >
                                                                {"剧本识别"}
                                                            </p>
                                                            <p
                                                                id="16_180"
                                                                className="Pixso-paragraph-16_180"
                                                            >
                                                                {
                                                                    "上传 TXT/DOC/DOCX 或直接粘贴文本，系统会自动解析角色、场景与物品，并支持增量识别（仅新增缺失资产）。"
                                                                }
                                                            </p>
                                                        </div>
                                                    </div>
                                                    <div
                                                        id="16_181"
                                                        className="stroke-wrapper-16_181"
                                                        style={{ cursor: "pointer" }}
                                                        onClick={() => setScriptText("")}
                                                    >
                                                        <div className="Pixso-frame-16_181">
                                                            <div className="frame-content-16_181">
                                                                <div
                                                                    id="16_182"
                                                                    className="Pixso-vector-16_182"
                                                                ></div>
                                                                <p
                                                                    id="16_187"
                                                                    className="Pixso-paragraph-16_187"
                                                                >
                                                                    {"清空文本"}
                                                                </p>
                                                            </div>
                                                        </div>
                                                        <div className="stroke-16_181"></div>
                                                    </div>
                                                </div>
                                            </div>
                                            
                                            {/* File Upload mock area */}
                                            <div
                                                id="16_188"
                                                className="stroke-wrapper-16_188"
                                            >
                                                <div className="Pixso-frame-16_188">
                                                    <div className="frame-content-16_188">
                                                        <div
                                                            id="16_189"
                                                            className="Pixso-frame-16_189"
                                                        >
                                                            <div
                                                                id="16_190"
                                                                className="Pixso-vector-16_190"
                                                            ></div>
                                                            <p
                                                                id="16_193"
                                                                className="Pixso-paragraph-16_193"
                                                            >
                                                                {
                                                                    "TXT / DOC / DOCX"
                                                                }
                                                            </p>
                                                            <p
                                                                id="16_194"
                                                                className="Pixso-paragraph-16_194"
                                                            >
                                                                {
                                                                    "≤ 200,000 字  拖拽或"
                                                                }
                                                            </p>
                                                            <p
                                                                id="16_195"
                                                                className="Pixso-paragraph-16_195"
                                                                style={{ cursor: "pointer", textDecoration: "underline" }}
                                                                onClick={() => {
                                                                    // Mock file selection
                                                                    setScriptText("阎王殿废墟大厅里狂风大作，落叶纷飞。男主角白起（中青衣壮汉，身穿黑色长袍与斗篷）右手缓缓握紧腰间佩戴的古老青铜古剑柄，指节因用力微微发白。而在他面前，身材轻盈、身穿淡白水袖仙裙的姬如雪冷然站立，眼神中流露出清冷。殿外山峰峡谷之巅，镇国将军怒吼咆哮，似乎预示着一场绝战将临。");
                                                                    useProjectStore.getState().setScriptText("阎王殿废墟大厅里狂风大作，落叶纷飞。男主角白起（中青衣壮汉，身穿黑色长袍与斗篷）右手缓缓握紧腰间佩戴的古老青铜古剑柄，指节因用力微微发白。而在他面前，身材轻盈、身穿淡白水袖仙裙的姬如雪冷然站立，眼神中流露出清冷。殿外山峰峡谷之巅，镇国将军怒吼咆哮，似乎预示着一场绝战将临。");
                                                                }}
                                                            >
                                                                {"选择示例剧本"}
                                                            </p>
                                                        </div>
                                                        <div
                                                            id="16_196"
                                                            className="Pixso-frame-16_196"
                                                        >
                                                            <div className="frame-content-16_196">
                                                                <p
                                                                    id="16_197"
                                                                    className="Pixso-paragraph-16_197"
                                                                >
                                                                    {isAnalyzed ? "已导入" : "待分析"}
                                                                </p>
                                                            </div>
                                                        </div>
                                                    </div>
                                                </div>
                                                <div className="stroke-16_188"></div>
                                            </div>

                                            {/* Textarea Input area */}
                                            <div
                                                id="16_198"
                                                className="stroke-wrapper-16_198"
                                                style={{ height: "300px" }}
                                            >
                                                <div className="Pixso-frame-16_198" style={{ height: "100%", padding: "10px" }}>
                                                    <div className="frame-content-16_198" style={{ display: "flex", flexDirection: "column", height: "100%", width: "100%" }}>
                                                        <textarea
                                                            placeholder="粘贴或输入剧本文本，支持 200,000 字以内"
                                                            value={scriptText}
                                                            onChange={(e) => {
                                                                setScriptText(e.target.value);
                                                                useProjectStore.getState().setScriptText(e.target.value);
                                                            }}
                                                            style={{
                                                                flex: 1,
                                                                width: "100%",
                                                                background: "transparent",
                                                                border: "none",
                                                                color: "#ffffff",
                                                                fontSize: "13px",
                                                                outline: "none",
                                                                resize: "none",
                                                                lineHeight: "1.6",
                                                                fontFamily: "inherit"
                                                            }}
                                                        />
                                                        <p
                                                            id="16_200"
                                                            className="Pixso-paragraph-16_200"
                                                            style={{ alignSelf: "flex-end", marginTop: "auto" }}
                                                        >
                                                            {`${scriptText.length} / 200000`}
                                                        </p>
                                                    </div>
                                                </div>
                                                <div className="stroke-16_198"></div>
                                            </div>

                                            {/* Template Selection */}
                                            <div
                                                id="16_201"
                                                className="Pixso-frame-16_201"
                                            >
                                                <div className="frame-content-16_201">
                                                    <div
                                                        id="16_202"
                                                        className="Pixso-frame-16_202"
                                                    >
                                                        <div className="frame-content-16_202">
                                                            <p
                                                                id="16_203"
                                                                className="Pixso-paragraph-16_203"
                                                            >
                                                                {
                                                                    "共享模板（可选）"
                                                                }
                                                            </p>
                                                            <p
                                                                id="16_204"
                                                                className="Pixso-paragraph-16_204"
                                                            >
                                                                {
                                                                    "选定从 skills/ 文件夹加载的提示词模板"
                                                                }
                                                            </p>
                                                        </div>
                                                    </div>
                                                    <div
                                                        id="16_205"
                                                        className="stroke-wrapper-16_205"
                                                        style={{ position: "relative" }}
                                                    >
                                                        <div className="Pixso-frame-16_205" style={{ padding: "0 10px", display: "flex", alignItems: "center" }}>
                                                            <select
                                                                value={selectedTemplate}
                                                                onChange={(e) => setSelectedTemplate(e.target.value)}
                                                                style={{
                                                                    width: "100%",
                                                                    background: "transparent",
                                                                    border: "none",
                                                                    color: "#ffffff",
                                                                    fontSize: "12px",
                                                                    outline: "none",
                                                                    cursor: "pointer",
                                                                    appearance: "none",
                                                                    paddingRight: "20px"
                                                                }}
                                                            >
                                                                {templates.map((tmpl) => (
                                                                    <option key={tmpl} value={tmpl} style={{ background: "#1f1f2e", color: "#fff" }}>
                                                                        {tmpl}
                                                                    </option>
                                                                ))}
                                                                <option value="通用资产提取" style={{ background: "#1f1f2e", color: "#fff" }}>通用资产提取 (内置默认)</option>
                                                            </select>
                                                            <div
                                                                id="16_209"
                                                                className="Pixso-vector-16_209"
                                                                style={{ pointerEvents: "none", position: "absolute", right: "12px" }}
                                                            ></div>
                                                        </div>
                                                        <div className="stroke-16_205"></div>
                                                    </div>
                                                </div>
                                            </div>

                                            {/* Visual Style Selection */}
                                            <div
                                                id="16_201_style"
                                                className="Pixso-frame-16_201"
                                                style={{ marginTop: "12px" }}
                                            >
                                                <div className="frame-content-16_201">
                                                    <div
                                                        id="16_202_style"
                                                        className="Pixso-frame-16_202"
                                                    >
                                                        <div className="frame-content-16_202">
                                                            <p
                                                                className="Pixso-paragraph-16_203"
                                                            >
                                                                {
                                                                    "视觉风格（当前）"
                                                                }
                                                            </p>
                                                            <p
                                                                className="Pixso-paragraph-16_204"
                                                            >
                                                                {
                                                                    "提取和生成角色时使用此风格描述"
                                                                }
                                                            </p>
                                                        </div>
                                                    </div>
                                                    <div
                                                        className="stroke-wrapper-16_205"
                                                        style={{ position: "relative" }}
                                                    >
                                                        <div className="Pixso-frame-16_205" style={{ padding: "0 10px", display: "flex", alignItems: "center" }}>
                                                            <select
                                                                value={visualStyle}
                                                                onChange={(e) => {
                                                                    useProjectStore.getState().setVisualStyle(e.target.value);
                                                                }}
                                                                style={{
                                                                    width: "100%",
                                                                    background: "transparent",
                                                                    border: "none",
                                                                    color: "#ffffff",
                                                                    fontSize: "12px",
                                                                    outline: "none",
                                                                    cursor: "pointer",
                                                                    appearance: "none",
                                                                    paddingRight: "20px"
                                                                }}
                                                            >
                                                                <option value="国漫电影感" style={{ background: "#1f1f2e", color: "#fff" }}>国漫电影感</option>
                                                                <option value="2D日漫剧场版" style={{ background: "#1f1f2e", color: "#fff" }}>2D日漫剧场版</option>
                                                                <option value="3D国风动画" style={{ background: "#1f1f2e", color: "#fff" }}>3D国风动画</option>
                                                                <option value="电影级写实" style={{ background: "#1f1f2e", color: "#fff" }}>电影级写实</option>
                                                                <option value="玄幻仙侠国漫" style={{ background: "#1f1f2e", color: "#fff" }}>玄幻仙侠国漫</option>
                                                                <option value="武侠写实国风" style={{ background: "#1f1f2e", color: "#fff" }}>武侠写实国风</option>
                                                                <option value="暗黑修仙风" style={{ background: "#1f1f2e", color: "#fff" }}>暗黑修仙风</option>
                                                                <option value="热血少年漫风" style={{ background: "#1f1f2e", color: "#fff" }}>热血少年漫风</option>
                                                                <option value="红果短剧AI漫剧风格" style={{ background: "#1f1f2e", color: "#fff" }}>红果短剧AI漫剧风格</option>
                                                            </select>
                                                            <div
                                                                className="Pixso-vector-16_209"
                                                                style={{ pointerEvents: "none", position: "absolute", right: "12px" }}
                                                            ></div>
                                                        </div>
                                                        <div className="stroke-16_205"></div>
                                                    </div>
                                                </div>
                                            </div>

                                            {/* Action Button: Analyze Script */}
                                            <div
                                                id="16_211"
                                                className="Pixso-frame-16_211"
                                                onClick={isAnalyzing ? undefined : handleAnalyzeScript}
                                                style={{ cursor: isAnalyzing ? "not-allowed" : "pointer", opacity: isAnalyzing ? 0.7 : 1 }}
                                            >
                                                <div className="frame-content-16_211">
                                                    <p
                                                        id="16_212"
                                                        className="Pixso-paragraph-16_212"
                                                    >
                                                        {isAnalyzing ? `正在分析中 (${analysisProgress}%)` : "分析剧本"}
                                                    </p>
                                                </div>
                                            </div>
                                        </div>
                                    </div>
                                    <div className="stroke-16_176"></div>
                                </div>
                                <div id="16_213" className="Pixso-frame-16_213">
                                    <div className="frame-content-16_213">
                                        <div
                                            id="16_214"
                                            className="Pixso-frame-16_214"
                                        >
                                            <div className="frame-content-16_214">
                                                <div
                                                    id="16_215"
                                                    className="Pixso-frame-16_215"
                                                >
                                                    <p
                                                        id="16_216"
                                                        className="Pixso-paragraph-16_216"
                                                    >
                                                        {"分析结果预览"}
                                                    </p>
                                                    <p
                                                        id="16_217"
                                                        className="Pixso-paragraph-16_217"
                                                    >
                                                        {
                                                            "快速浏览剧本解析出来的关键实体与分集颗粒度。"
                                                        }
                                                    </p>
                                                </div>
                                                <div
                                                    id="16_218"
                                                    className="stroke-wrapper-16_218"
                                                    style={{ cursor: "pointer" }}
                                                    onClick={handleAnalyzeScript}
                                                >
                                                    <div className="Pixso-frame-16_218">
                                                        <div className="frame-content-16_218">
                                                            <div
                                                                id="16_219"
                                                                className="Pixso-frame-16_219"
                                                            ></div>
                                                            <p
                                                                id="16_220"
                                                                className="Pixso-paragraph-16_220"
                                                            >
                                                                {"重新分析"}
                                                            </p>
                                                        </div>
                                                    </div>
                                                    <div className="stroke-16_218"></div>
                                                </div>
                                            </div>
                                        </div>
                                        
                                        {/* Status and Progress summary bar */}
                                        <div
                                            id="16_221"
                                            className="stroke-wrapper-16_221"
                                        >
                                            <div className="Pixso-frame-16_221" style={{ position: "relative", overflow: "hidden" }}>
                                                {/* Visual progress bar highlight */}
                                                <div style={{
                                                    position: "absolute",
                                                    left: 0,
                                                    top: 0,
                                                    bottom: 0,
                                                    width: isAnalyzing ? `${analysisProgress}%` : (isAnalyzed ? "100%" : "0%"),
                                                    background: "rgba(139, 92, 246, 0.15)",
                                                    transition: "width 0.3s ease-out",
                                                    borderRadius: "8px",
                                                    pointerEvents: "none"
                                                }} />
                                                
                                                <div className="frame-content-16_221" style={{ position: "relative", zIndex: 1 }}>
                                                    <p
                                                        id="16_222"
                                                        className="Pixso-paragraph-16_222"
                                                    >
                                                        {"最近分析时间"}
                                                    </p>
                                                    <p
                                                        id="16_223"
                                                        className="Pixso-paragraph-16_223"
                                                    >
                                                        {analysisTime || "暂无记录"}
                                                    </p>
                                                    <p
                                                        id="16_224"
                                                        className="Pixso-paragraph-16_224"
                                                    >
                                                        {isAnalyzing ? `${analysisProgress}%` : (isAnalyzed ? "100%" : "0%")}
                                                    </p>
                                                    <p
                                                        id="16_225"
                                                        className="Pixso-paragraph-16_225"
                                                    >
                                                        {isAnalyzing 
                                                            ? "分析中..." 
                                                            : (isAnalyzed ? `已完成 ${characters.length + scenes.length}/${characters.length + scenes.length}` : "已完成 0/0")}
                                                    </p>
                                                </div>
                                            </div>
                                            <div className="stroke-16_221"></div>
                                        </div>

                                        {/* Current Status message */}
                                        <div
                                            id="16_226"
                                            className="stroke-wrapper-16_226"
                                        >
                                            <div className="Pixso-frame-16_226">
                                                <div className="frame-content-16_226">
                                                    <p
                                                        id="16_227"
                                                        className="Pixso-paragraph-16_227"
                                                    >
                                                        {isAnalyzing ? "正在提取资产实体..." : (isAnalyzed ? "资产提取完成" : "尚未分析")}
                                                    </p>
                                                    <p
                                                        id="16_228"
                                                        className="Pixso-paragraph-16_228"
                                                    >
                                                        {isAnalyzing 
                                                            ? "系统正在努力检查剧本并识别角色、场景与物品实体，请稍候..." 
                                                            : (isAnalyzed 
                                                                ? "系统已成功识别剧本中的角色、场景、物品与生物实体，您可以在左侧面板中查看和管理。" 
                                                                : "系统会在检查剧本后自动识别角色、场景、物品等实体。")}
                                                    </p>
                                                    
                                                    {/* Entity Counts Cards */}
                                                    <div
                                                        id="16_229"
                                                        className="Pixso-frame-16_229"
                                                    >
                                                        <div className="frame-content-16_229">
                                                            {/* 1. Characters Card */}
                                                            <div
                                                                id="16_230"
                                                                className="stroke-wrapper-16_230"
                                                            >
                                                                <div className="Pixso-frame-16_230">
                                                                    <div className="frame-content-16_230">
                                                                        <div
                                                                            id="16_231"
                                                                            className="Pixso-frame-16_231"
                                                                        >
                                                                            <div
                                                                                id="16_232"
                                                                                className="Pixso-vector-16_232"
                                                                            ></div>
                                                                            <p
                                                                                id="16_237"
                                                                                className="Pixso-paragraph-16_237"
                                                                            >
                                                                                {
                                                                                    "角色"
                                                                                }
                                                                            </p>
                                                                        </div>
                                                                        <p
                                                                            id="16_238"
                                                                            className="Pixso-paragraph-16_238"
                                                                        >
                                                                            {characters.length}
                                                                        </p>
                                                                        <p
                                                                            id="16_239"
                                                                            className="Pixso-paragraph-16_239"
                                                                        >
                                                                            {
                                                                                isAnalyzed ? "源于剧本自动识别" : "未源于角色自动识别"
                                                                            }
                                                                        </p>
                                                                    </div>
                                                                </div>
                                                                <div className="stroke-16_230"></div>
                                                            </div>

                                                            {/* 2. Scenes Card */}
                                                            <div
                                                                id="16_240"
                                                                className="stroke-wrapper-16_240"
                                                            >
                                                                <div className="Pixso-frame-16_240">
                                                                    <div className="frame-content-16_240">
                                                                        <div
                                                                            id="16_241"
                                                                            className="Pixso-frame-16_241"
                                                                        >
                                                                            <div
                                                                                id="16_242"
                                                                                className="Pixso-frame-16_242"
                                                                            >
                                                                                <div
                                                                                    id="16_243"
                                                                                    className="stroke-wrapper-16_243"
                                                                                >
                                                                                    <div className="Pixso-rectangle-16_243"></div>
                                                                                    <div className="stroke-16_243"></div>
                                                                                </div>
                                                                                <div
                                                                                    id="16_244"
                                                                                    className="Pixso-vector-16_244"
                                                                                ></div>
                                                                                <div
                                                                                    id="16_245"
                                                                                    className="Pixso-vector-16_245"
                                                                                ></div>
                                                                            </div>
                                                                            <p
                                                                                id="16_246"
                                                                                className="Pixso-paragraph-16_246"
                                                                            >
                                                                                {
                                                                                    "场景"
                                                                                }
                                                                            </p>
                                                                        </div>
                                                                        <p
                                                                            id="16_247"
                                                                            className="Pixso-paragraph-16_247"
                                                                        >
                                                                            {scenes.length}
                                                                        </p>
                                                                        <p
                                                                            id="16_248"
                                                                            className="Pixso-paragraph-16_248"
                                                                        >
                                                                            {
                                                                                "覆盖的场景数量"
                                                                            }
                                                                        </p>
                                                                    </div>
                                                                </div>
                                                                <div className="stroke-16_240"></div>
                                                            </div>

                                                            {/* 3. Items Card */}
                                                            <div
                                                                id="16_249"
                                                                className="stroke-wrapper-16_249"
                                                            >
                                                                <div className="Pixso-frame-16_249">
                                                                    <div className="frame-content-16_249">
                                                                        <div
                                                                            id="16_250"
                                                                            className="Pixso-frame-16_250"
                                                                        >
                                                                            <div
                                                                                id="16_251"
                                                                                className="Pixso-vector-16_251"
                                                                            ></div>
                                                                            <p
                                                                                id="16_256"
                                                                                className="Pixso-paragraph-16_256"
                                                                            >
                                                                                {
                                                                                    "物品"
                                                                                }
                                                                            </p>
                                                                        </div>
                                                                        <p
                                                                            id="16_257"
                                                                            className="Pixso-paragraph-16_257"
                                                                        >
                                                                            {items.length}
                                                                        </p>
                                                                        <p
                                                                            id="16_258"
                                                                            className="Pixso-paragraph-16_258"
                                                                        >
                                                                            {
                                                                                "关键道具数量"
                                                                            }
                                                                        </p>
                                                                    </div>
                                                                </div>
                                                                <div className="stroke-16_249"></div>
                                                            </div>

                                                            {/* 4. Organisms Card */}
                                                            <div
                                                                id="16_259"
                                                                className="stroke-wrapper-16_259"
                                                            >
                                                                <div className="Pixso-frame-16_259">
                                                                    <div className="frame-content-16_259">
                                                                        <div
                                                                            id="16_260"
                                                                            className="Pixso-frame-16_260"
                                                                        >
                                                                            <div
                                                                                id="16_261"
                                                                                className="Pixso-vector-16_261"
                                                                            ></div>
                                                                            <p
                                                                                id="16_264"
                                                                                className="Pixso-paragraph-16_264"
                                                                            >
                                                                                {
                                                                                    "生物"
                                                                                }
                                                                            </p>
                                                                        </div>
                                                                        <p
                                                                            id="16_265"
                                                                            className="Pixso-paragraph-16_265"
                                                                        >
                                                                            {organisms.length}
                                                                        </p>
                                                                        <p
                                                                            id="16_266"
                                                                            className="Pixso-paragraph-16_266"
                                                                        >
                                                                            {
                                                                                "涉及的动物/生物"
                                                                            }
                                                                        </p>
                                                                    </div>
                                                                </div>
                                                                <div className="stroke-16_259"></div>
                                                            </div>

                                                            {/* 5. Crowds Card */}
                                                            <div className="stroke-wrapper-16_230">
                                                                <div className="Pixso-frame-16_230">
                                                                    <div className="frame-content-16_230">
                                                                        <div className="Pixso-frame-16_231">
                                                                            <div className="Pixso-vector-16_232"></div>
                                                                            <p className="Pixso-paragraph-16_237">{"群像"}</p>
                                                                        </div>
                                                                        <p className="Pixso-paragraph-16_238">{crowds.length}</p>
                                                                        <p className="Pixso-paragraph-16_239">{isAnalyzed ? "阵营/群体数量" : "未识别群像"}</p>
                                                                    </div>
                                                                </div>
                                                                <div className="stroke-16_230"></div>
                                                            </div>
                                                        </div>
                                                    </div>
                                                </div>
                                            </div>
                                            <div className="stroke-16_226"></div>
                                        </div>

                                        {/* Episodes/Split Overview summary */}
                                        <div
                                            id="16_267"
                                            className="stroke-wrapper-16_267"
                                        >
                                            <div className="Pixso-frame-16_267">
                                                <div className="frame-content-16_267">
                                                    <p
                                                        id="16_268"
                                                        className="Pixso-paragraph-16_268"
                                                    >
                                                        {"分集概览"}
                                                    </p>
                                                    <p
                                                        id="16_269"
                                                        className="Pixso-paragraph-16_269"
                                                    >
                                                        {
                                                            "确认剧本内容是否已经覆盖所有分集。"
                                                        }
                                                    </p>
                                                    <div
                                                        id="16_270"
                                                        className="stroke-wrapper-16_270"
                                                    >
                                                        <div className="Pixso-frame-16_270">
                                                            <div className="frame-content-16_270">
                                                                <div
                                                                    id="16_271"
                                                                    className="Pixso-frame-16_271"
                                                                >
                                                                    <div
                                                                        id="16_272"
                                                                        className="Pixso-frame-16_272"
                                                                    >
                                                                        <div
                                                                            id="16_273"
                                                                            className="stroke-wrapper-16_273"
                                                                        >
                                                                            <div className="Pixso-rectangle-16_273"></div>
                                                                            <div className="stroke-16_273"></div>
                                                                        </div>
                                                                        <div
                                                                            id="16_274"
                                                                            className="Pixso-vector-16_274"
                                                                        ></div>
                                                                        <div
                                                                            id="16_275"
                                                                            className="Pixso-vector-16_275"
                                                                        ></div>
                                                                        <div
                                                                            id="16_276"
                                                                            className="Pixso-vector-16_276"
                                                                        ></div>
                                                                        <div
                                                                            id="16_277"
                                                                            className="Pixso-vector-16_277"
                                                                        ></div>
                                                                        <div
                                                                            id="16_278"
                                                                            className="Pixso-vector-16_278"
                                                                        ></div>
                                                                        <div
                                                                            id="16_279"
                                                                            className="Pixso-vector-16_279"
                                                                        ></div>
                                                                        <div
                                                                            id="16_280"
                                                                            className="Pixso-vector-16_280"
                                                                        ></div>
                                                                    </div>
                                                                    <p
                                                                        id="16_281"
                                                                        className="Pixso-paragraph-16_281"
                                                                    >
                                                                        {
                                                                            "分集数量"
                                                                        }
                                                                    </p>
                                                                </div>
                                                                <p
                                                                    id="16_282"
                                                                    className="Pixso-paragraph-16_282"
                                                                >
                                                                    {"0"}
                                                                </p>
                                                                <p
                                                                    id="16_283"
                                                                    className="Pixso-paragraph-16_283"
                                                                >
                                                                    {
                                                                        "脚本中可识别的章节/分集总量"
                                                                    }
                                                                </p>
                                                            </div>
                                                        </div>
                                                        <div className="stroke-16_270"></div>
                                                    </div>
                                                </div>
                                            </div>
                                            <div className="stroke-16_267"></div>
                                        </div>
                                    </div>
                                </div>
                            </div>
                        </div>
                    </div>
                </div>
            </div>
        </div>
    );
};
export default Frame1693;
