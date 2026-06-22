import { useState, useEffect, useMemo } from "react";
import EditorHeader from "@/components/EditorHeader";
import EditorSidebar from "@/components/EditorSidebar";
import { useProjectStore } from "@/store/projectStore";
import { useCatalogStore } from "@/store/catalogStore";
import { runPurpose } from "@/services/purposeRunner";
import ModelPicker, { effectiveModelKey } from "@/components/ModelPicker";
import "@/styles/Frame1693.css";

// 提示词正文已全量交由管理端（catalog 模板）拼接；用户端只发 templateId + 变量(原文/素材) + 模型 + 参数。
// 下列 formatXxxForTemplate 仅把"已有资产"整理成变量字符串（数据，非模板正文）。

// Helper formatters for template variables
// 查重列表只需「身份」——编号 + 名称 + 已有变体，供模型对照"勿重复设计"。
// 不再塞整段出图提示词（27 个资产会上万字，既臃肿又挤占续提的输出预算）。
function codeFromId(id: string): string {
    const m = String(id || "").match(/^([A-Za-z]+\d+[A-Za-z]*)/); // "C01-<ts>-<n>" → "C01"
    return m ? m[1] : "";
}
function compactAssetLine(a: any): string {
    const code = codeFromId(a.id);
    const vs = Array.isArray(a.variants) && a.variants.length
        ? `（变体: ${a.variants.map((v: any) => (v.label || v.name)).filter(Boolean).join(" / ")}）`
        : "";
    return `${[code, a.name].filter(Boolean).join(" ")}${vs}`;
}
function formatAssetsForDedup(arr: any[], emptyHint: string): string {
    if (!arr || arr.length === 0) return emptyHint;
    return arr.map(compactAssetLine).join("、");
}
function formatCharactersForTemplate(characters: any[]) { return formatAssetsForDedup(characters, "无角色数据"); }
function formatScenesForTemplate(scenes: any[]) { return formatAssetsForDedup(scenes, "无场景数据"); }
function formatItemsForTemplate(items: any[]) { return formatAssetsForDedup(items, "无物品/道具数据"); }
function formatOrganismsForTemplate(organisms: any[]) { return formatAssetsForDedup(organisms, "无生物数据"); }

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

// 截断兜底：当整段 JSON 因输出超长被截断（顶层对象未闭合，JSON.parse 必失败）时，
// 从指定数组(arrayKey)里逐个抠出**已完整闭合**的元素对象，丢弃末尾不完整的那个。
// 这样模型在掐断前已生成的资产不会全部丢失。
function recoverArrayObjects(text: string, arrayKey: string): any[] {
    const keyIdx = text.indexOf(`"${arrayKey}"`);
    if (keyIdx < 0) return [];
    const bracket = text.indexOf("[", keyIdx);
    if (bracket < 0) return [];
    const objs: any[] = [];
    let i = bracket + 1;
    while (i < text.length) {
        const ch = text[i];
        if (ch === "]") break;             // 数组正常闭合
        if (ch !== "{") { i++; continue; } // 跳过元素间的逗号/空白
        // 对该元素做花括号配平（容忍字符串内的括号与转义）
        let depth = 0, inStr = false, esc = false, j = i;
        for (; j < text.length; j++) {
            const c = text[j];
            if (inStr) { if (esc) esc = false; else if (c === "\\") esc = true; else if (c === '"') inStr = false; }
            else if (c === '"') inStr = true;
            else if (c === "{") depth++;
            else if (c === "}") { depth--; if (depth === 0) break; }
        }
        if (depth !== 0 || j >= text.length) break; // 末尾对象不完整 → 抢救到此为止
        try { objs.push(JSON.parse(text.slice(i, j + 1))); } catch { /* 单个坏对象跳过 */ }
        i = j + 1;
    }
    return objs;
}

// 抠出某 key 后第一个完整 JSON 对象（用于即便整段被截断也能取到靠前的 visualBible）
function recoverObjectAfterKey(text: string, key: string): any | null {
    const keyIdx = text.indexOf(`"${key}"`);
    if (keyIdx < 0) return null;
    const start = text.indexOf("{", keyIdx);
    if (start < 0) return null;
    let depth = 0, inStr = false, esc = false;
    for (let i = start; i < text.length; i++) {
        const c = text[i];
        if (inStr) { if (esc) esc = false; else if (c === "\\") esc = true; else if (c === '"') inStr = false; }
        else if (c === '"') inStr = true;
        else if (c === "{") depth++;
        else if (c === "}") { depth--; if (depth === 0) { try { return JSON.parse(text.slice(start, i + 1)); } catch { return null; } } }
    }
    return null;
}

type VisualBible = { style: string; colorSystem: string; negativeGlobal: string };
const asStr = (v: any): string => Array.isArray(v) ? v.filter(Boolean).join("、") : (v == null ? "" : String(v));
// 从输出里取「项目视觉圣经」三字段（全局风格/全局色调/全局禁用词），容忍多种字段名与截断
function extractVisualBible(text: string, root: any | null): VisualBible {
    const vb = (root && root.visualBible) || recoverObjectAfterKey(text, "visualBible") || {};
    return {
        style: asStr(vb.style ?? vb.视觉风格 ?? vb.styleAnchors),
        colorSystem: asStr(vb.colorSystem ?? vb.colorTone ?? vb.colorPalette ?? vb.全局色调),
        negativeGlobal: asStr(vb.negativeGlobal ?? vb.negativeBaseline ?? vb.negative ?? vb.全局禁用词 ?? vb.全局禁用),
    };
}

type ParsedAsset = { id: string; name: string; features: string; philosophy: string; prompt: string; image?: string; variants: any[] };

// 解析资产提取 LLM 输出（asset.extract.v1）：按 C/A/G/M/S/P 编号前缀分流到 角色/场景/生物/物品，变体折叠进父资产。
// 兼容两种结构：扁平 assets[]（带 id/type/prompt）与嵌套 characters[]/scenes[]/creatures[]/props[]。
function parseAssetExtraction(text: string): {
    characters: ParsedAsset[]; scenes: ParsedAsset[]; items: ParsedAsset[]; organisms: ParsedAsset[]; crowds: ParsedAsset[];
    /** 项目视觉圣经（全局风格/色调/禁用词） */
    visualBible: VisualBible;
    /** 模型输出被截断、仅抢救出部分资产时为 true */
    truncated: boolean;
    /** 截断时，文档顺序最后一个完整资产的「编号 名称」，用于提示用户"大概提取到哪里" */
    lastLabel: string;
} {
    const root = extractJsonObject(text);
    const visualBible = extractVisualBible(text, root);
    const empty = { characters: [] as ParsedAsset[], scenes: [] as ParsedAsset[], items: [] as ParsedAsset[], organisms: [] as ParsedAsset[], crowds: [] as ParsedAsset[], visualBible, truncated: false, lastLabel: "" };

    // 统一成一个扁平 assets 列表
    const flat: any[] = [];
    let truncated = false;
    const expandInto = (arr: any, cat: string) => Array.isArray(arr) && arr.forEach((a) => {
        flat.push({ ...a, category: a.category || cat });
        (a.variants || []).forEach((v: any) => flat.push({ ...v, category: a.category || cat, inheritsFrom: v.inheritsFrom || v.inherits_from || a.code || a.id }));
    });

    if (root) {
        if (Array.isArray(root.assets)) flat.push(...root.assets);
        else { expandInto(root.characters, "character"); expandInto(root.scenes, "scene"); expandInto(root.creatures, "creature"); expandInto(root.props, "prop"); }
    } else {
        // 完整 JSON 解析失败（多半是输出超长被截断）→ 从各候选数组抢救已闭合的资产对象，不让前面生成的全废
        const flatAssets = recoverArrayObjects(text, "assets");
        if (flatAssets.length) flat.push(...flatAssets);
        else {
            expandInto(recoverArrayObjects(text, "characters"), "character");
            expandInto(recoverArrayObjects(text, "scenes"), "scene");
            expandInto(recoverArrayObjects(text, "creatures"), "creature");
            expandInto(recoverArrayObjects(text, "props"), "prop");
            expandInto(recoverArrayObjects(text, "crowds"), "crowd");
        }
        if (flat.length) truncated = true; // 抢救到了东西 = 确属截断
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
    // 截断时标注大概提取到哪个资产（flat 为文档顺序，末元素即最后一个完整资产）
    const lastRaw = flat[flat.length - 1];
    const lastLabel = truncated
        ? [String(lastRaw?.id || lastRaw?.code || "").trim(), String(lastRaw?.name || lastRaw?.title || "").trim()].filter(Boolean).join(" ")
        : "";
    return { ...buckets, visualBible, truncated, lastLabel };
}

// 松类型：store 端各类资产字段不一（场景/道具用 description、variants 可选），合并只依赖 name + variants
type AnyAsset = { name: string; variants?: any[];[k: string]: any };
type ExtractBuckets = { characters: AnyAsset[]; scenes: AnyAsset[]; items: AnyAsset[]; organisms: AnyAsset[]; crowds: AnyAsset[] };

// 续提合并：把新一轮结果并入现有资产。按「名称」在各类内去重——
// 同名视为同一资产、不重复加入；同名时把新变体（按 label/name）并进已有资产。返回合并结果 + 实际新增数。
function mergeExtraction(cur: ExtractBuckets, add: ExtractBuckets): { merged: ExtractBuckets; addedCount: number } {
    let added = 0;
    const mergeCat = (a: AnyAsset[], b: AnyAsset[]): AnyAsset[] => {
        const out = a.map((x) => ({ ...x, variants: [...(x.variants || [])] }));
        const byName = new Map(out.map((x) => [String(x.name).trim(), x] as const));
        for (const nb of b) {
            const key0 = String(nb.name).trim();
            const hit = byName.get(key0);
            if (!hit) { const nbN = { ...nb, variants: [...(nb.variants || [])] }; out.push(nbN); byName.set(key0, nbN); added++; continue; }
            const seen = new Set((hit.variants || []).map((v: any) => String(v.label || v.name).trim()));
            for (const nv of nb.variants || []) {
                const key = String(nv.label || nv.name).trim();
                if (key && !seen.has(key)) { hit.variants.push(nv); seen.add(key); added++; }
            }
        }
        return out;
    };
    return {
        merged: {
            characters: mergeCat(cur.characters, add.characters),
            scenes: mergeCat(cur.scenes, add.scenes),
            items: mergeCat(cur.items, add.items),
            organisms: mergeCat(cur.organisms, add.organisms),
            crowds: mergeCat(cur.crowds, add.crowds),
        },
        addedCount: added,
    };
}

// 解析「分集边界」LLM 输出（模型只返回每集 标题 + 起始锚点句，输出短不截断）。
// 兼容 anchor/start/firstLine/scriptText 等字段；解析不到返回空，不编造。
function parseEpisodeBoundaries(text: string): Array<{ title: string; anchor: string }> {
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
                anchor: String(e.anchor || e.start || e.firstLine || e.startLine || e.scriptText || "").trim(),
            }))
            .filter((e) => e.title || e.anchor);
    } catch {
        return [];
    }
}

// 按锚点把原文确定性切成每集文本：在原文中依次定位每个 anchor，相邻 anchor 之间即一集（原文零损失）。
function sliceEpisodesByAnchors(
    scriptText: string,
    boundaries: Array<{ title: string; anchor: string }>,
): Array<{ title: string; scriptText: string }> {
    if (boundaries.length === 0) return [];
    // 找到每个 anchor 在原文中的位置（从上一集之后继续找，保证顺序、避免回跳）
    const marks: Array<{ title: string; pos: number }> = [];
    let cursor = 0;
    for (const b of boundaries) {
        let pos = b.anchor ? scriptText.indexOf(b.anchor, cursor) : -1;
        if (pos < 0 && b.anchor) pos = scriptText.indexOf(b.anchor.slice(0, 12), cursor); // 锚点首段兜底
        if (pos < 0) pos = cursor; // 仍找不到 → 紧接上一集（不丢内容）
        marks.push({ title: b.title, pos });
        cursor = pos + 1;
    }
    // 第一集从 0 开始（含锚点前的开场），其余从各自锚点起，到下一集锚点止
    const out: Array<{ title: string; scriptText: string }> = [];
    for (let i = 0; i < marks.length; i++) {
        const start = i === 0 ? 0 : marks[i].pos;
        const end = i + 1 < marks.length ? marks[i + 1].pos : scriptText.length;
        const seg = scriptText.slice(start, end).trim();
        out.push({ title: marks[i].title, scriptText: seg });
    }
    return out.filter((e) => e.scriptText);
}

const Frame1693 = () => {
    const characters = useProjectStore((s) => s.characters);
    const scenes = useProjectStore((s) => s.scenes);
    const items = useProjectStore((s) => s.items);
    const organisms = useProjectStore((s) => s.organisms);
    const crowds = useProjectStore((s) => s.crowds);
    const episodes = useProjectStore((s) => s.episodes);
    const isAnalyzed = useProjectStore((s) => s.isAnalyzed);
    const analysisTime = useProjectStore((s) => s.analysisTime);
    const visualStyle = useProjectStore((s) => s.visualStyle) || "国漫电影感";
    const visualBible = useProjectStore((s) => s.visualBible);
    const setVisualBibleStore = useProjectStore((s) => s.setVisualBible);

    const [scriptText, setScriptText] = useState(useProjectStore.getState().scriptText || "");
    // 进行态搬到 store：切走再切回（组件卸载/重挂）不丢进度，因底层轮询是单例后台
    const isAnalyzing = useProjectStore((s) => s.analysisRunning);
    const analysisProgress = useProjectStore((s) => s.analysisProgress);
    const setIsAnalyzing = useProjectStore((s) => s.setAnalysisRunning);
    const setAnalysisProgress = useProjectStore((s) => s.setAnalysisProgress);

    // 资产提取模板（管理端 catalog 下发，purpose=script.analyze；排除内部模板）
    const allTemplates = useCatalogStore((s) => s.catalog?.templates);
    const extractTemplates = useMemo(
        () => (allTemplates ?? []).filter((t) => t.purpose === "script.analyze" && t.category !== "内部"),
        [allTemplates],
    );
    const [selectedTemplateId, setSelectedTemplateId] = useState("");
    // 默认选中 catalog 默认模板（isDefault 优先）
    useEffect(() => {
        if (extractTemplates.length === 0) { setSelectedTemplateId(""); return; }
        if (!extractTemplates.some((t) => t.id === selectedTemplateId)) {
            setSelectedTemplateId((extractTemplates.find((t) => t.isDefault) ?? extractTemplates[0]).id);
        }
    }, [extractTemplates, selectedTemplateId]);

    const storeScriptText = useProjectStore((s) => s.scriptText);
    useEffect(() => {
        setScriptText(storeScriptText);
    }, [storeScriptText]);

    const handleAnalyzeScript = async () => {
        if (!scriptText.trim()) {
            alert("请输入剧本文本后再进行分析");
            return;
        }
        if (!selectedTemplateId) {
            alert("请先选择资产提取模板（需先在管理端配置并连接）。");
            return;
        }
        setIsAnalyzing(true);
        setAnalysisProgress(10);

        let truncationMsg = ""; // 非空 = 提取被截断，成功流程末尾提醒用户

        try {
            setAnalysisProgress(30);

            // 提示词正文留服务端：只发 templateId + 变量(原文/视觉风格/已有资产列表/当前时间)
            const now0 = new Date();
            const variables = {
                视觉风格: visualStyle,
                原文: scriptText,
                角色列表: formatCharactersForTemplate(useProjectStore.getState().characters || []),
                场景列表: formatScenesForTemplate(useProjectStore.getState().scenes || []),
                物品列表: formatItemsForTemplate(useProjectStore.getState().items || []),
                生物列表: formatOrganismsForTemplate(useProjectStore.getState().organisms || []),
                当前时间: `${now0.getFullYear()}/${String(now0.getMonth() + 1).padStart(2, "0")}/${String(now0.getDate()).padStart(2, "0")} ${String(now0.getHours()).padStart(2, "0")}:${String(now0.getMinutes()).padStart(2, "0")}:${String(now0.getSeconds()).padStart(2, "0")}`,
            };

            setAnalysisProgress(50);

            // 经统一 purpose 管线提交 + 集中轮询（替代各 Frame 自建的 30×1s 轮询）
            const run = await runPurpose("script.analyze", {
                templateId: selectedTemplateId,
                variables,
                modelKey: effectiveModelKey("text") || undefined,
                // 整段出图模板设计下，每个资产带 ~500 字提示词，长剧本资产多→输出极长。
                // 4096 远不够（实测 1.8 万字仍被截断）。放宽到 65535，配合 parseAssetExtraction 的截断兜底。
                params: { temperature: 0.7, maxTokens: 65535 },
                onProgress: (progress, status, partialText) => {
                    if (status === "running" || status === "queued") {
                        setAnalysisProgress(Math.min(95, 50 + Math.round(progress * 0.4)));
                    }
                    // 流式：把目前已完整的资产/视觉圣经实时刷入 store（提取一个刷新一个）
                    if (partialText && partialText.length > 40) {
                        const live = parseAssetExtraction(partialText);
                        const liveTotal = live.characters.length + live.scenes.length + live.items.length + live.organisms.length + live.crowds.length;
                        if (liveTotal > 0) {
                            useProjectStore.getState().setAnalysisResult({
                                characters: live.characters, scenes: live.scenes, items: live.items,
                                organisms: live.organisms, crowds: live.crowds, visualBible: live.visualBible,
                                time: "解析中…",
                            });
                        } else if (live.visualBible.style || live.visualBible.colorSystem || live.visualBible.negativeGlobal) {
                            useProjectStore.getState().setVisualBible(live.visualBible);
                        }
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
                visualBible: extracted.visualBible,
                time: timeString,
            });

            // 截断提醒：模型输出过长被掐断，只抢救出部分资产 → 明确告知用户可能不完整、大概到哪里。
            // 注意：setAnalysisResult 是整体替换而非合并，「重新分析」会重跑全部（仍可能再次截断），
            // 不能靠它增量补；故引导用户精简/分批，或确认已调大上限后重试。
            if (extracted.truncated) {
                const total = extracted.characters.length + extracted.scenes.length + extracted.items.length + extracted.organisms.length + extracted.crowds.length;
                truncationMsg =
                    `⚠ 模型输出过长被截断，仅抢救出 ${total} 个资产` +
                    (extracted.lastLabel ? `（约提取到「${extracted.lastLabel}」处）` : "") +
                    `。\n其后的资产可能未提取（本轮甚至可能尚未涉及场景/道具）。\n\n建议点击「继续提取」——它会把已提取的资产作为查重清单喂回模型，只补全剩余、不重复、不覆盖已有；可反复点击直到提示"无新增"。`;
            }

            // 自动分集（边界法）：模型只返回每集 标题+起始锚点句（输出短不截断），
            // 客户端按锚点在原文里确定性切出每集文本（原文零损失）。写入 episodes 供「视频」界面。
            // best-effort：失败不影响已提取的资产（视频界面仍可手动「新建分集」）。
            try {
                const epRun = await runPurpose("script.analyze", {
                    templateId: "script.episodes.basic",
                    variables: { 原文: scriptText },
                    modelKey: effectiveModelKey("text") || undefined,
                    params: { temperature: 0.3, maxTokens: 4096 }, // 仅边界，输出很短
                });
                if (epRun.status === "success" && epRun.resultUri) {
                    const boundaries = parseEpisodeBoundaries(epRun.resultUri);
                    const eps = sliceEpisodesByAnchors(scriptText, boundaries);
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

            // 资产已落库、UI 已更新后再弹截断提醒（避免阻塞渲染）
            if (truncationMsg) alert(truncationMsg);

        } catch (err) {
            console.error("Script analysis failed:", err);
            alert(`剧本分析失败：${err instanceof Error ? err.message : "未知错误"}`);
            setIsAnalyzing(false);
            setAnalysisProgress(0);
        }
    };

    // 继续提取（分批续提，补全剩余资产）：
    // 把当前已提取资产作为「已设计资产库（查重用）」喂回模型（模板已内置该段），
    // 模型据此跳过已有、只产新增；结果与现有按名称合并（不覆盖、不重复）。可反复点击直到无新增。
    const handleContinueExtraction = async () => {
        if (!isAnalyzed) { alert("请先「分析剧本」得到首批资产，再继续提取。"); return; }
        if (!scriptText.trim()) { alert("剧本文本为空。"); return; }
        if (!selectedTemplateId) { alert("请先选择资产提取模板。"); return; }
        setIsAnalyzing(true);
        setAnalysisProgress(20);
        let msg = "";
        try {
            const st = useProjectStore.getState();
            const cur: ExtractBuckets = {
                characters: st.characters || [], scenes: st.scenes || [], items: st.items || [],
                organisms: st.organisms || [], crowds: st.crowds || [],
            };
            const now0 = new Date();
            const variables = {
                视觉风格: visualStyle,
                原文: scriptText,
                // 已设计资产库（查重用）——紧凑身份清单，模型据此"勿重复设计"
                角色列表: formatCharactersForTemplate([...cur.characters, ...cur.crowds]),
                场景列表: formatScenesForTemplate(cur.scenes),
                物品列表: formatItemsForTemplate(cur.items),
                生物列表: formatOrganismsForTemplate(cur.organisms),
                当前时间: `${now0.getFullYear()}/${String(now0.getMonth() + 1).padStart(2, "0")}/${String(now0.getDate()).padStart(2, "0")} ${String(now0.getHours()).padStart(2, "0")}:${String(now0.getMinutes()).padStart(2, "0")}:${String(now0.getSeconds()).padStart(2, "0")}`,
            };
            setAnalysisProgress(40);
            const run = await runPurpose("script.analyze", {
                templateId: selectedTemplateId,
                variables,
                modelKey: effectiveModelKey("text") || undefined,
                params: { temperature: 0.7, maxTokens: 65535 },
                onProgress: (progress, status) => {
                    if (status === "running" || status === "queued") {
                        setAnalysisProgress(Math.min(95, 40 + Math.round(progress * 0.5)));
                    }
                },
            });
            if (run.status === "no_model") throw new Error("未配置可用的文本模型，请先在「设置 → 模型」中选择后重试。");
            if (run.status === "failed") throw new Error(run.error || "继续提取失败");
            const resultText = run.resultUri || "";
            if (!resultText.trim()) throw new Error("模型返回为空。");

            const add = parseAssetExtraction(resultText);
            const { merged, addedCount } = mergeExtraction(cur, add);

            const now = new Date();
            const timeString = `${now.getFullYear()}/${String(now.getMonth() + 1).padStart(2, "0")}/${String(now.getDate()).padStart(2, "0")}   ${String(now.getHours()).padStart(2, "0")}:${String(now.getMinutes()).padStart(2, "0")}`;
            st.setAnalysisResult({ ...merged, time: timeString });
            await st.save(true);

            if (addedCount === 0) {
                msg = add.truncated
                    ? "本轮未解析出新资产，但模型输出仍被截断。可再点一次「继续提取」试试。"
                    : "✅ 未发现新资产——剧本资产应已提取完整。";
            } else {
                msg = `✅ 本轮新增 ${addedCount} 个资产（已与现有合并、未覆盖）。` +
                    (add.truncated
                        ? `\n输出仍被截断${add.lastLabel ? `（约到「${add.lastLabel}」）` : ""}，可能还有遗漏，请再点「继续提取」继续补全。`
                        : `\n本轮输出完整。可再点一次「继续提取」，若提示"无新增"即代表提取完毕。`);
            }
        } catch (err) {
            console.error("Continue extraction failed:", err);
            msg = `继续提取失败：${err instanceof Error ? err.message : "未知错误"}`;
        } finally {
            setAnalysisProgress(100);
            setTimeout(() => { setIsAnalyzing(false); setAnalysisProgress(0); }, 300);
            if (msg) alert(msg);
        }
    };

    return (
        <div className="scroll-container">
            <div id="16_93" className="Pixso-frame-16_93">
                <EditorHeader title="剧本配置" />
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
                                                                value={selectedTemplateId}
                                                                onChange={(e) => setSelectedTemplateId(e.target.value)}
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
                                                                {extractTemplates.length === 0 && (
                                                                    <option value="" style={{ background: "#1f1f2e", color: "#fff" }}>（未加载管理端模板）</option>
                                                                )}
                                                                {extractTemplates.map((t) => (
                                                                    <option key={t.id} value={t.id} style={{ background: "#1f1f2e", color: "#fff" }}>
                                                                        {t.name}
                                                                    </option>
                                                                ))}
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

                                            {/* 文本模型选择（剧本分析 / 自动分集 共用） */}
                                            <div style={{ marginTop: "12px", padding: "0 2px" }}>
                                                <ModelPicker cap="text" label="分析模型（文本）" />
                                            </div>

                                            {/* Action Button: Analyze Script */}
                                            <div
                                                id="16_211"
                                                className="Pixso-frame-16_211"
                                                onClick={(isAnalyzing || !selectedTemplateId) ? undefined : handleAnalyzeScript}
                                                style={{ cursor: (isAnalyzing || !selectedTemplateId) ? "not-allowed" : "pointer", opacity: (isAnalyzing || !selectedTemplateId) ? 0.7 : 1 }}
                                                title={!selectedTemplateId ? "请先选择资产提取模板（需连接管理端并加载模板）" : ""}
                                            >
                                                <div className="frame-content-16_211">
                                                    <p
                                                        id="16_212"
                                                        className="Pixso-paragraph-16_212"
                                                    >
                                                        {isAnalyzing ? `正在分析中 (${analysisProgress}%)` : (selectedTemplateId ? "分析剧本" : "请先选择模板")}
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
                                                <div style={{ display: "flex", gap: 8 }}>
                                                    {/* 继续提取：把已提取资产作查重清单喂回模型，只补全剩余、不重复不覆盖 */}
                                                    <div
                                                        className="stroke-wrapper-16_218"
                                                        style={{ cursor: (isAnalyzing || !isAnalyzed) ? "not-allowed" : "pointer", opacity: (isAnalyzing || !isAnalyzed) ? 0.45 : 1 }}
                                                        title="把已提取的资产作为查重清单喂回模型，只补全剩余资产（不重复、不覆盖已有），可反复点击直到无新增"
                                                        onClick={(isAnalyzing || !isAnalyzed) ? undefined : handleContinueExtraction}
                                                    >
                                                        <div className="Pixso-frame-16_218">
                                                            <div className="frame-content-16_218">
                                                                <div className="Pixso-frame-16_219"></div>
                                                                <p className="Pixso-paragraph-16_220">
                                                                    {"继续提取"}
                                                                </p>
                                                            </div>
                                                        </div>
                                                        <div className="stroke-16_218"></div>
                                                    </div>
                                                    <div
                                                        id="16_218"
                                                        className="stroke-wrapper-16_218"
                                                        style={{ cursor: isAnalyzing ? "not-allowed" : "pointer", opacity: isAnalyzing ? 0.45 : 1 }}
                                                        onClick={isAnalyzing ? undefined : handleAnalyzeScript}
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

                                                    {/* Entity Counts Cards（6 项 2 行 3 列：角色/场景/物品/生物/群像/分集） */}
                                                    <div
                                                        id="16_229"
                                                        className="Pixso-frame-16_229"
                                                    >
                                                        <div className="frame-content-16_229" style={{ display: "grid", gridTemplateColumns: "repeat(3, 1fr)", gap: 16, alignItems: "stretch" }}>
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

                                                            {/* 6. Episodes Card（分集并入实体卡） */}
                                                            <div className="stroke-wrapper-16_230">
                                                                <div className="Pixso-frame-16_230">
                                                                    <div className="frame-content-16_230">
                                                                        <div className="Pixso-frame-16_231">
                                                                            <div className="Pixso-vector-16_232"></div>
                                                                            <p className="Pixso-paragraph-16_237">{"分集"}</p>
                                                                        </div>
                                                                        <p className="Pixso-paragraph-16_238">{episodes.length}</p>
                                                                        <p className="Pixso-paragraph-16_239">{isAnalyzed ? "脚本可识别的分集总量" : "未分集"}</p>
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

                                        {/* 项目视觉圣经：全局风格 / 全局色调 / 全局反向提示词（资产提取产出，三栏布局，可编辑） */}
                                        <div style={{ marginBottom: 16, padding: 16, borderRadius: 12, background: "rgba(255,255,255,0.03)", border: "1px solid rgba(255,255,255,0.08)" }}>
                                            <div style={{ display: "flex", alignItems: "baseline", gap: 8, marginBottom: 10 }}>
                                                <span style={{ fontSize: 14, fontWeight: 600, color: "#fff" }}>项目视觉圣经</span>
                                                <span style={{ fontSize: 11, color: "rgba(255,255,255,0.45)" }}>全局锚点 · 所有资产继承，禁止漂移</span>
                                            </div>
                                            <div style={{ display: "grid", gridTemplateColumns: "repeat(3, 1fr)", gap: 12 }}>
                                                {([
                                                    { key: "style", label: "全局风格", ph: "如：3D国风动画，院线级非真人化次世代国漫…" },
                                                    { key: "colorSystem", label: "全局色调", ph: "如：主色青铜绿、阴煞黑、符箓金…" },
                                                    { key: "negativeGlobal", label: "全局反向提示词", ph: "如：禁止真人写实、照片级毛孔、UE5真人扫描脸…" },
                                                ] as const).map((f) => (
                                                    <div key={f.key} style={{ display: "flex", flexDirection: "column" }}>
                                                        <div style={{ fontSize: 12, color: "rgba(255,255,255,0.6)", marginBottom: 4 }}>{f.label}</div>
                                                        <textarea
                                                            value={visualBible[f.key] || ""}
                                                            onChange={(e) => setVisualBibleStore({ [f.key]: e.target.value })}
                                                            placeholder={f.ph}
                                                            style={{ width: "100%", minHeight: 120, resize: "vertical", boxSizing: "border-box", padding: "8px 10px", borderRadius: 8, background: "rgba(0,0,0,0.25)", border: "1px solid rgba(255,255,255,0.1)", color: "#fff", fontSize: 12, lineHeight: 1.5, outline: "none" }}
                                                        />
                                                    </div>
                                                ))}
                                            </div>
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
