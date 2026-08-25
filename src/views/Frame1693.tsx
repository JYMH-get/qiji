import { useState, useEffect, useMemo } from "react";
import { RefreshCw, ListPlus, User, Image as ImageIcon, Package, PawPrint, Users, Clapperboard } from "lucide-react";
import EditorHeader from "@/components/EditorHeader";
import EditorSidebar from "@/components/EditorSidebar";
import { useProjectStore } from "@/store/projectStore";
import { confirmDialog } from "@/lib/confirmDialog";
import { useCatalogStore } from "@/store/catalogStore";
import { runPurpose } from "@/services/purposeRunner";
import { trackTask } from "@/services/taskCenter";
import ModelPicker, { effectiveModelKey } from "@/components/ModelPicker";
import { mergeExtraction, mergeApply, type ExtractBuckets } from "@/lib/assetMerge";
import { attachSplitPresets } from "@/lib/splitPresetAttach";
import { QUICK_SPLIT_ID, QUICK_BLANKLINE_ID, QUICK_N1_ID, QUICK_NN_ID, QUICK_SPLIT_CHOICES, QUICK_SPLIT_IDS } from "@/lib/splitChoices";
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

type ParsedAsset = { id: string; name: string; features: string; philosophy: string; prompt: string; image?: string; variants: any[]; code?: string; inheritsFrom?: string; variantPayload?: any };

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
            code: code || undefined,
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
        // 父资产不在本轮结果里（典型：「继续提取」时父在上一轮）——保留父编号 inheritsFrom + 变体原始载荷，
        // 留待 mergeExtraction 按父编号回挂到已有资产的 variants；找不到父才退化为基础资产。
        else buckets[bucketOf(a)].push({ id: variant.id, name: variant.name || code, features: variant.description, philosophy: "", prompt: variant.prompt, image: undefined, variants: [], code: code || undefined, inheritsFrom: pcode, variantPayload: variant });
    }
    // 截断时标注大概提取到哪个资产（flat 为文档顺序，末元素即最后一个完整资产）
    const lastRaw = flat[flat.length - 1];
    const lastLabel = truncated
        ? [String(lastRaw?.id || lastRaw?.code || "").trim(), String(lastRaw?.name || lastRaw?.title || "").trim()].filter(Boolean).join(" ")
        : "";
    return { ...buckets, visualBible, truncated, lastLabel };
}

// 合并落库逻辑已抽到 @/lib/assetMerge（第85轮）：画布资产拆分节点与本页共用同一条入库链路。

// 剧集拆分「快速拆分」选项 id：第243轮抽到 @/lib/splitChoices（新建项目页共用），此处仅 re-import。

// 按空行（连续两次及以上换行）切块
function splitByBlankLines(scriptText: string): string[] {
    return (scriptText || "").split(/\n\s*\n+/).map((b) => b.trim()).filter(Boolean);
}
// 连续两次换行拆分：每个空行块 = 一集（扁平编号 第N集）
function splitEpisodesByBlankLine(scriptText: string): Array<{ title: string; scriptText: string }> {
    return splitByBlankLines(scriptText).map((b, i) => ({ title: `第${i + 1}集`, scriptText: b }));
}

// 在剧本里找「主-副」编号标记（行首形如 1-1 / 2-3 / 1.2，或带「场」前缀的 场1-1 / 场2-3），
// 返回 {major,minor,index(全局偏移),label}。容差「场」前缀：剧本若以「场n-n」格式分场，n-n/n-1 也能拆。
function findShotMarkers(scriptText: string): Array<{ major: number; minor: number; index: number; label: string }> {
    const lines = (scriptText || "").split(/\r?\n/);
    const out: Array<{ major: number; minor: number; index: number; label: string }> = [];
    let offset = 0;
    for (const line of lines) {
        const m = line.match(/^(\s*)(?:场\s*)?(\d+)\s*[-－—.·、:：]\s*(\d+)/);
        if (m) {
            const major = Number(m[2]), minor = Number(m[3]);
            out.push({ major, minor, index: offset + (m[1] ? m[1].length : 0), label: `${major}-${minor}` });
        }
        offset += line.length + 1; // +1 为换行符
    }
    return out;
}
// 按边界索引切片；首个边界前的内容（若有）作「0-引言」
function sliceByBoundaries(text: string, boundaries: Array<{ index: number; label: string }>): Array<{ title: string; scriptText: string }> {
    const eps: Array<{ title: string; scriptText: string }> = [];
    const firstIdx = boundaries.length ? boundaries[0].index : text.length;
    const intro = text.slice(0, firstIdx).trim();
    if (intro) eps.push({ title: "0-引言", scriptText: intro });
    for (let i = 0; i < boundaries.length; i++) {
        const start = boundaries[i].index;
        const end = i + 1 < boundaries.length ? boundaries[i + 1].index : text.length;
        const seg = text.slice(start, end).trim();
        if (seg) eps.push({ title: boundaries[i].label, scriptText: seg });
    }
    return eps;
}
// n-n（逢数拆分）：每遇到一个编号标记就拆 → 1-1,1-2,1-3,2-1,2-2…（最细）
function splitEpisodesNN(scriptText: string): Array<{ title: string; scriptText: string }> {
    const markers = findShotMarkers(scriptText);
    if (markers.length === 0) return [];
    return sliceByBoundaries(scriptText, markers.map((m) => ({ index: m.index, label: m.label })));
}
// n-1（逢1拆分）：只在主编号变化处拆（副编号变化不拆）→ 每个主组首个标记为边界 1-1,2-1,3-1…
function splitEpisodesN1(scriptText: string): Array<{ title: string; scriptText: string }> {
    const markers = findShotMarkers(scriptText);
    if (markers.length === 0) return [];
    const boundaries: Array<{ index: number; label: string }> = [];
    let prevMajor: number | null = null;
    for (const m of markers) {
        if (prevMajor === null || m.major !== prevMajor) { boundaries.push({ index: m.index, label: m.label }); prevMajor = m.major; }
    }
    return sliceByBoundaries(scriptText, boundaries);
}

// 简单分集（确定性、无需 LLM）：按原文中的「第N集/章/回/话/幕」标题切分。
// N 支持阿拉伯数字与中文数字；每集标题取标记所在整行。找不到任何标记则返回空（由调用方兜底为单集）。
function splitEpisodesByMarkers(scriptText: string): Array<{ title: string; scriptText: string }> {
    const text = scriptText || "";
    const re = /第\s*[0-9一二三四五六七八九十百千零〇两]+\s*[集章回话幕]/g;
    const marks: Array<{ index: number; title: string }> = [];
    let m: RegExpExecArray | null;
    while ((m = re.exec(text)) !== null) {
        const lineEnd = text.indexOf("\n", m.index);
        const title = text.slice(m.index, lineEnd < 0 ? text.length : lineEnd).trim();
        marks.push({ index: m.index, title });
    }
    if (marks.length === 0) return [];
    const out: Array<{ title: string; scriptText: string }> = [];
    for (let i = 0; i < marks.length; i++) {
        const start = marks[i].index;
        const end = i + 1 < marks.length ? marks[i + 1].index : text.length;
        const seg = text.slice(start, end).trim();
        if (seg) out.push({ title: marks[i].title, scriptText: seg });
    }
    return out;
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
    // 剧集拆分独立运行态（与资产拆分解耦：点哪个跑哪个，互不禁用、互不显示对方进度）
    const [episodeSplitting, setEpisodeSplitting] = useState(false);

    // 资产提取模板（管理端 catalog 下发，purpose=script.analyze；排除内部模板）
    const allTemplates = useCatalogStore((s) => s.catalog?.templates);
    const extractTemplates = useMemo(
        () => (allTemplates ?? []).filter((t) => t.purpose === "script.analyze" && t.category !== "内部"),
        [allTemplates],
    );
    // 第243轮：拆分模板选择随项目持久化（mediaSettings，新建项目页可预设；此前是会话态换页即丢）。
    // 存量值/失效值回落 catalog 默认款（isDefault 优先），改选即回写 setMediaSettings。
    const assetExtractTplStored = useProjectStore((s) => s.mediaSettings?.assetExtractTplId);
    const selectedTemplateId = useMemo(() => {
        if (extractTemplates.length === 0) return "";
        if (assetExtractTplStored && extractTemplates.some((t) => t.id === assetExtractTplStored)) return assetExtractTplStored;
        return (extractTemplates.find((t) => t.isDefault) ?? extractTemplates[0]).id;
    }, [extractTemplates, assetExtractTplStored]);

    // 剧集拆分模板：内置「快速拆分」(不调用大模型，按"第N集/章/回"标记确定性切) + catalog 剧集类模板。
    const episodeTemplates = useMemo(
        () => (allTemplates ?? []).filter((t) => t.category === "剧集"),
        [allTemplates],
    );
    // 默认 n-n（第121轮用户定）；持久化值失效（模板被删/catalog 未到货）时回落 n-n
    const episodeTplStored = useProjectStore((s) => s.mediaSettings?.episodeTplId);
    const episodeTemplateId = useMemo(() => {
        if (episodeTplStored && (QUICK_SPLIT_IDS.has(episodeTplStored) || episodeTemplates.some((t) => t.id === episodeTplStored))) return episodeTplStored;
        return QUICK_NN_ID;
    }, [episodeTplStored, episodeTemplates]);

    const storeScriptText = useProjectStore((s) => s.scriptText);
    useEffect(() => {
        setScriptText(storeScriptText);
    }, [storeScriptText]);

    // 断连恢复：上次分析若在途（analysisTask 已落盘）且本会话尚未在跟踪 → 凭 taskId 重连服务端取结果。
    // 覆盖「分析中关闭/刷新客户端」的场景（服务端任务仍在内存中跑）。只在挂载时尝试一次。
    useEffect(() => {
        const at = useProjectStore.getState().analysisTask;
        if (!at) return;
        if (useProjectStore.getState().analysisRunning) return; // 同会话仍在跟踪，无需恢复
        let done = false;
        // 归属校验基准：恢复发起时的项目实例（onUpdate 期间若用户切走了项目，停止写库防串台）
        const owner = useProjectStore.getState().projectInstanceId;
        const s0 = useProjectStore.getState();
        s0.setAnalysisRunning(true);
        s0.setAnalysisProgress(40);
        trackTask({
            taskId: at.taskId,
            adapterKey: at.adapterKey,
            onUpdate: (progress, status, resultUri, _err, _aid, partialText) => {
                if (done) return;
                // 用户已切到别的项目 → 停止跟踪、不写当前项目（原项目返回时会再次自恢复）
                if (useProjectStore.getState().projectInstanceId !== owner) { done = true; return; }
                const s = useProjectStore.getState();
                if (status === "queued" || status === "running") {
                    s.setAnalysisProgress(Math.min(95, 40 + Math.round(progress * 0.5)));
                    if (partialText && partialText.length > 40) {
                        const live = parseAssetExtraction(partialText);
                        const t = live.characters.length + live.scenes.length + live.items.length + live.organisms.length + live.crowds.length;
                        // 流式：合并保留（不整体替换），已生成的图与 id 不丢
                        if (t > 0) mergeApply(owner, { characters: live.characters, scenes: live.scenes, items: live.items, organisms: live.organisms, crowds: live.crowds }, live.visualBible, "解析中…");
                    }
                    return;
                }
                done = true;
                if (status === "success") {
                    const ex = parseAssetExtraction(resultUri || "");
                    const now = new Date();
                    const ts = `${now.getFullYear()}/${String(now.getMonth() + 1).padStart(2, "0")}/${String(now.getDate()).padStart(2, "0")}   ${String(now.getHours()).padStart(2, "0")}:${String(now.getMinutes()).padStart(2, "0")}`;
                    // 最终结果：合并到**当前最新** store（含恢复期间生成的图），保留旧资产
                    mergeApply(owner, { characters: ex.characters, scenes: ex.scenes, items: ex.items, organisms: ex.organisms, crowds: ex.crowds }, ex.visualBible, ts);
                }
                s.setAnalysisTask(null);
                s.setAnalysisRunning(false);
                s.setAnalysisProgress(status === "success" ? 100 : 0);
                void s.save(true);
            },
        });
        return () => { done = true; };
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, []);

    // 资产拆分：只提取角色/场景/物品/生物/群像（不再附带分集，分集由「剧集拆分」独立按键负责）
    const handleExtractAssets = async () => {
        if (!scriptText.trim()) {
            alert("请输入剧本文本后再进行分析");
            return;
        }
        if (!selectedTemplateId) {
            alert("请先选择资产拆分模板（需先在管理端配置并连接）。");
            return;
        }
        setIsAnalyzing(true);
        setAnalysisProgress(10);
        // 归属校验基准：本次分析归属于发起时的项目。回调/完成时若已切走，放弃落库防串台。
        const owner = useProjectStore.getState().projectInstanceId;

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
                // 落盘在途任务：关客户端后重开可凭 taskId 重连服务端取结果（见挂载时的断连恢复 useEffect）
                onTaskId: (taskId, adapterKey) => {
                    if (useProjectStore.getState().projectInstanceId !== owner) return; // 已切项目，不写当前项目
                    useProjectStore.getState().setAnalysisTask({ taskId, adapterKey, kind: "analyze", startedAt: Date.now() });
                },
                onProgress: (progress, status, partialText) => {
                    if (useProjectStore.getState().projectInstanceId !== owner) return; // 已切项目，丢弃流式回调防串台
                    if (status === "running" || status === "queued") {
                        setAnalysisProgress(Math.min(95, 50 + Math.round(progress * 0.4)));
                    }
                    // 流式：合并保留刷入 store（提取一个并入一个；已生成的图与 id 不丢，见 mergeApply）
                    if (partialText && partialText.length > 40) {
                        const live = parseAssetExtraction(partialText);
                        const liveTotal = live.characters.length + live.scenes.length + live.items.length + live.organisms.length + live.crowds.length;
                        if (liveTotal > 0) {
                            mergeApply(owner, { characters: live.characters, scenes: live.scenes, items: live.items, organisms: live.organisms, crowds: live.crowds }, live.visualBible, "解析中…");
                        } else if (live.visualBible.style || live.visualBible.colorSystem || live.visualBible.negativeGlobal) {
                            useProjectStore.getState().setVisualBible(live.visualBible);
                        }
                    }
                },
            });

            // 用户已切到别的项目：放弃落库（原项目的 analysisTask 已落盘，返回时断连恢复会重连取结果）
            if (useProjectStore.getState().projectInstanceId !== owner) return;

            // 任务已终态：清掉在途记录（无论成败），避免下次启动误重连
            useProjectStore.getState().setAnalysisTask(null);

            // 无兜底：没有可用模型 / 失败 → 直接报错，绝不给假数据
            if (run.status === "no_model") {
                throw new Error("无可用文本模型：请检查「设置 → 管理端」连接与目录拉取后重试。");
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

            // 最终结果：合并到当前最新 store（保留旧资产与拆分期间生成的图、稳定 id），而非整体替换
            mergeApply(owner, {
                characters: extracted.characters,
                scenes: extracted.scenes,
                items: extracted.items,
                organisms: extracted.organisms,
                crowds: extracted.crowds,
            }, extracted.visualBible, timeString);

            // 截断提醒：模型输出过长被掐断，只抢救出部分资产 → 明确告知用户可能不完整、大概到哪里。
            // 现在是合并保留（不删旧资产）：可点「继续提取」补全剩余、不重复、不覆盖已有。
            if (extracted.truncated) {
                const total = extracted.characters.length + extracted.scenes.length + extracted.items.length + extracted.organisms.length + extracted.crowds.length;
                truncationMsg =
                    `⚠ 模型输出过长被截断，仅抢救出 ${total} 个资产` +
                    (extracted.lastLabel ? `（约提取到「${extracted.lastLabel}」处）` : "") +
                    `。\n其后的资产可能未提取（本轮甚至可能尚未涉及场景/道具）。\n\n建议点击「继续提取」——它会把已提取的资产作为查重清单喂回模型，只补全剩余、不重复、不覆盖已有；可反复点击直到提示"无新增"。`;
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

    // 剧集拆分：把剧本切成多集，写入 episodes 供「视频」界面。
    // 「快速拆分」= 不调用大模型，纯本地按「第N集/章/回」标记确定性切分（找不到标记 → 整篇为单集）。
    // 选中 catalog 剧集模板时走 LLM 边界法（暂未提供该类模板，预留分支）。
    const handleSplitEpisodes = async () => {
        if (!scriptText.trim()) { alert("请输入剧本文本后再进行剧集拆分。"); return; }
        if (episodeSplitting) return;
        // 已有拆分成果（多集、或任一集带正文/分镜）→ 再次拆分=整体覆盖，须用户确认（新项目的单个空默认分集不算）。
        // ⚠ 确认必须走 confirmDialog（Tauri 下 window.confirm 不弹窗直接放行，见 src/lib/confirmDialog.ts）
        const existing = useProjectStore.getState().episodes;
        const hasContent = existing.length > 1 || existing.some((e) => (e.shots?.length || 0) > 0 || !!e.scriptText?.trim());
        if (hasContent) {
            const shotCount = existing.reduce((s, e) => s + (e.shots?.length || 0), 0);
            const ok = await confirmDialog(
                `⚠ 再次拆分将覆盖现有 ${existing.length} 集分集${shotCount ? `及其全部 ${shotCount} 个分镜（含推理结果/故事板图/视频引用）` : ""}，覆盖后无法恢复。\n\n确定要重新拆分吗？`,
            );
            if (!ok) return;
        }
        setEpisodeSplitting(true);
        let msg = "";
        const owner = useProjectStore.getState().projectInstanceId;
        try {
            let eps: Array<{ title: string; scriptText: string }> = [];

            if (episodeTemplateId === QUICK_SPLIT_ID) {
                // 快速拆分：本地确定性切分（按「第N集/章/回」标记）
                eps = splitEpisodesByMarkers(scriptText);
                if (eps.length === 0) eps = [{ title: "第1集", scriptText: scriptText.trim() }];
            } else if (episodeTemplateId === QUICK_BLANKLINE_ID) {
                eps = splitEpisodesByBlankLine(scriptText);
                if (eps.length === 0) eps = [{ title: "第1集", scriptText: scriptText.trim() }];
            } else if (episodeTemplateId === QUICK_N1_ID) {
                eps = splitEpisodesN1(scriptText);
                if (eps.length === 0) throw new Error("未在原文找到「主-副」编号标记（如行首 1-1、2-3 或 场1-1、场2-3），无法用 n-1 拆分。请确认原文带编号，或改用其它拆分方式。");
            } else if (episodeTemplateId === QUICK_NN_ID) {
                eps = splitEpisodesNN(scriptText);
                if (eps.length === 0) throw new Error("未在原文找到「主-副」编号标记（如行首 1-1、2-3 或 场1-1、场2-3），无法用 n-n 拆分。请确认原文带编号，或改用其它拆分方式。");
            } else {
                // LLM 模板分集（按所选 catalog 模板提交，输出按「第N集」标题正文）
                const run = await runPurpose("script.analyze", {
                    templateId: episodeTemplateId,
                    variables: { 原文: scriptText },
                    modelKey: effectiveModelKey("text") || undefined,
                    params: { temperature: 0.3, maxTokens: 8192 },
                });
                if (run.status === "no_model") throw new Error("无可用文本模型：请检查「设置 → 管理端」连接与目录拉取后重试。");
                if (run.status === "failed") throw new Error(run.error || "剧集拆分失败");
                eps = splitEpisodesByMarkers(run.resultUri || "");
                if (eps.length === 0) eps = [{ title: "第1集", scriptText: (run.resultUri || scriptText).trim() }];
            }

            // 已切到别的项目 → 放弃写 episodes，避免串台
            if (useProjectStore.getState().projectInstanceId !== owner) { msg = ""; return; }
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
            await useProjectStore.getState().save(true);
            msg = `✅ 已拆分为 ${eps.length} 集（可在「视频」界面查看/编辑）。`;
        } catch (err) {
            console.error("Split episodes failed:", err);
            msg = `剧集拆分失败：${err instanceof Error ? err.message : "未知错误"}`;
        } finally {
            setEpisodeSplitting(false);
            if (msg) alert(msg);
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
        // 归属校验基准（提到 try 外，供 finally 判断是否仍是原项目）
        const owner = useProjectStore.getState().projectInstanceId;
        try {
            // 提交时的资产快照（仅用于喂模型查重，不作合并基准）
            const st = useProjectStore.getState();
            const submitCur: ExtractBuckets = {
                characters: st.characters || [], scenes: st.scenes || [], items: st.items || [],
                organisms: st.organisms || [], crowds: st.crowds || [],
            };
            const now0 = new Date();
            const variables = {
                视觉风格: visualStyle,
                原文: scriptText,
                // 已设计资产库（查重用）——紧凑身份清单，模型据此"勿重复设计"
                角色列表: formatCharactersForTemplate([...submitCur.characters, ...submitCur.crowds]),
                场景列表: formatScenesForTemplate(submitCur.scenes),
                物品列表: formatItemsForTemplate(submitCur.items),
                生物列表: formatOrganismsForTemplate(submitCur.organisms),
                当前时间: `${now0.getFullYear()}/${String(now0.getMonth() + 1).padStart(2, "0")}/${String(now0.getDate()).padStart(2, "0")} ${String(now0.getHours()).padStart(2, "0")}:${String(now0.getMinutes()).padStart(2, "0")}:${String(now0.getSeconds()).padStart(2, "0")}`,
            };
            setAnalysisProgress(40);
            const run = await runPurpose("script.analyze", {
                templateId: selectedTemplateId,
                variables,
                modelKey: effectiveModelKey("text") || undefined,
                params: { temperature: 0.7, maxTokens: 65535 },
                onTaskId: (taskId, adapterKey) => {
                    if (useProjectStore.getState().projectInstanceId !== owner) return;
                    useProjectStore.getState().setAnalysisTask({ taskId, adapterKey, kind: "continue", startedAt: Date.now() });
                },
                onProgress: (progress, status) => {
                    if (useProjectStore.getState().projectInstanceId !== owner) return;
                    if (status === "running" || status === "queued") {
                        setAnalysisProgress(Math.min(95, 40 + Math.round(progress * 0.5)));
                    }
                },
            });
            // 用户已切到别的项目：放弃落库（原项目 analysisTask 已落盘，返回时自恢复）
            if (useProjectStore.getState().projectInstanceId !== owner) { msg = ""; return; }
            useProjectStore.getState().setAnalysisTask(null); // 任务已终态，清在途记录
            if (run.status === "no_model") throw new Error("无可用文本模型：请检查「设置 → 管理端」连接与目录拉取后重试。");
            if (run.status === "failed") throw new Error(run.error || "继续提取失败");
            const resultText = run.resultUri || "";
            if (!resultText.trim()) throw new Error("模型返回为空。");

            const add = parseAssetExtraction(resultText);
            // 合并基准 = **最新** store（含续提期间用户生成的图），而非提交时的陈旧快照——修「续提丢已生成资产」
            const fresh = useProjectStore.getState();
            const freshCur: ExtractBuckets = {
                characters: fresh.characters || [], scenes: fresh.scenes || [], items: fresh.items || [],
                organisms: fresh.organisms || [], crowds: fresh.crowds || [],
            };
            const { merged, addedCount } = mergeExtraction(freshCur, add, attachSplitPresets);

            const now = new Date();
            const timeString = `${now.getFullYear()}/${String(now.getMonth() + 1).padStart(2, "0")}/${String(now.getDate()).padStart(2, "0")}   ${String(now.getHours()).padStart(2, "0")}:${String(now.getMinutes()).padStart(2, "0")}`;
            fresh.setAnalysisResult({ ...merged, time: timeString });
            await fresh.save(true);

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
            // 仅当仍是原项目才重置进度/运行态，避免切走后误动新项目的 UI
            if (useProjectStore.getState().projectInstanceId === owner) {
                setAnalysisProgress(100);
                setTimeout(() => { setIsAnalyzing(false); setAnalysisProgress(0); }, 300);
            }
            if (msg) alert(msg);
        }
    };

    // 配置区两列网格共用样式
    const fieldLabelStyle: React.CSSProperties = { fontSize: 11, color: "rgba(255,255,255,0.55)", marginBottom: 4, display: "block" };
    const fieldSelectStyle: React.CSSProperties = { width: "100%", background: "rgba(255,255,255,0.05)", border: "1px solid rgba(255,255,255,0.12)", borderRadius: 6, color: "#fff", padding: "8px 10px", fontSize: 12, outline: "none", cursor: "pointer", appearance: "none" };
    // 次级操作按钮（重新分析 / 继续提取）——带可见图标
    const headerBtnStyle = (disabled: boolean): React.CSSProperties => ({
        display: "inline-flex", alignItems: "center", gap: 6, flexShrink: 0,
        padding: "8px 14px", borderRadius: 8,
        background: "rgba(139,92,246,0.14)", border: "1px solid rgba(139,92,246,0.45)",
        color: "#c4b5fd", fontSize: 13, fontWeight: 600, whiteSpace: "nowrap", userSelect: "none",
        cursor: disabled ? "not-allowed" : "pointer", opacity: disabled ? 0.45 : 1,
    });
    const splitBtnStyle = (disabled: boolean): React.CSSProperties => ({
        flex: 1, textAlign: "center", padding: "12px 0", borderRadius: 8,
        background: "linear-gradient(90deg,#7c3aed,#8b5cf6)", color: "#fff", fontSize: 14, fontWeight: 600,
        cursor: disabled ? "not-allowed" : "pointer", opacity: disabled ? 0.55 : 1, userSelect: "none",
    });

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

                                            {/* 配置区：两行三列网格（撑满宽度）——
                                                列1 模型/风格、列2 剧集模板/资产模板、列3 剧集拆分/资产拆分按键。
                                                剧集拆分在上、资产拆分在下；两者运行态独立（点哪个跑哪个，互不禁用、互不显示对方进度）。 */}
                                            <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr 1fr", gap: 12, marginTop: 12, width: "100%", alignItems: "end" }}>
                                                {/* 行1 列1：模型选择 */}
                                                <ModelPicker cap="text" label="分析模型（文本）" />

                                                {/* 行1 列2：剧集拆分模板 */}
                                                <label>
                                                    <span style={fieldLabelStyle}>剧集拆分模板</span>
                                                    <select
                                                        value={episodeTemplateId}
                                                        onChange={(e) => useProjectStore.getState().setMediaSettings({ episodeTplId: e.target.value })}
                                                        style={fieldSelectStyle}
                                                    >
                                                        {QUICK_SPLIT_CHOICES.map((c) => (
                                                            <option key={c.id} value={c.id} style={{ background: "#1f1f2e" }}>{c.label}</option>
                                                        ))}
                                                        {episodeTemplates.map((t) => (
                                                            <option key={t.id} value={t.id} style={{ background: "#1f1f2e" }}>
                                                                {t.name}
                                                            </option>
                                                        ))}
                                                    </select>
                                                </label>

                                                {/* 行1 列3：剧集拆分按键（独立运行态 episodeSplitting） */}
                                                <div
                                                    onClick={episodeSplitting ? undefined : handleSplitEpisodes}
                                                    style={splitBtnStyle(episodeSplitting)}
                                                    title="把剧本切分为多集（快速拆分不调用大模型）；与资产拆分独立，点哪个跑哪个"
                                                >
                                                    {episodeSplitting ? "拆分中…" : "剧集拆分"}
                                                </div>

                                                {/* 行2 列1：风格选择 */}
                                                <label>
                                                    <span style={fieldLabelStyle}>视觉风格</span>
                                                    <select
                                                        value={visualStyle}
                                                        onChange={(e) => useProjectStore.getState().setVisualStyle(e.target.value)}
                                                        style={fieldSelectStyle}
                                                    >
                                                        <option value="国漫电影感" style={{ background: "#1f1f2e" }}>国漫电影感</option>
                                                        <option value="2D日漫剧场版" style={{ background: "#1f1f2e" }}>2D日漫剧场版</option>
                                                        <option value="3D国风动画" style={{ background: "#1f1f2e" }}>3D国风动画</option>
                                                        <option value="电影级写实" style={{ background: "#1f1f2e" }}>电影级写实</option>
                                                        <option value="玄幻仙侠国漫" style={{ background: "#1f1f2e" }}>玄幻仙侠国漫</option>
                                                        <option value="武侠写实国风" style={{ background: "#1f1f2e" }}>武侠写实国风</option>
                                                        <option value="暗黑修仙风" style={{ background: "#1f1f2e" }}>暗黑修仙风</option>
                                                        <option value="热血少年漫风" style={{ background: "#1f1f2e" }}>热血少年漫风</option>
                                                        <option value="红果短剧AI漫剧风格" style={{ background: "#1f1f2e" }}>红果短剧AI漫剧风格</option>
                                                    </select>
                                                </label>

                                                {/* 行2 列2：资产拆分模板 */}
                                                <label>
                                                    <span style={fieldLabelStyle}>资产拆分模板</span>
                                                    <select
                                                        value={selectedTemplateId}
                                                        onChange={(e) => useProjectStore.getState().setMediaSettings({ assetExtractTplId: e.target.value })}
                                                        style={fieldSelectStyle}
                                                    >
                                                        {extractTemplates.length === 0 && (
                                                            <option value="" style={{ background: "#1f1f2e" }}>（未加载管理端模板）</option>
                                                        )}
                                                        {extractTemplates.map((t) => (
                                                            <option key={t.id} value={t.id} style={{ background: "#1f1f2e" }}>
                                                                {t.name}
                                                            </option>
                                                        ))}
                                                    </select>
                                                </label>

                                                {/* 行2 列3：资产拆分按键（独立运行态 isAnalyzing） */}
                                                <div
                                                    onClick={(isAnalyzing || !selectedTemplateId) ? undefined : handleExtractAssets}
                                                    style={splitBtnStyle(isAnalyzing || !selectedTemplateId)}
                                                    title={!selectedTemplateId ? "请先选择资产拆分模板（需连接管理端并加载模板）" : ""}
                                                >
                                                    {isAnalyzing ? `处理中 (${analysisProgress}%)` : (selectedTemplateId ? "资产拆分" : "请先选择模板")}
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
                                            </div>
                                        </div>

                                        {/* Status bar（最近分析时间）——重新分析置于容器右上角，与「继续提取」对应 */}
                                        <div
                                            id="16_221"
                                            className="stroke-wrapper-16_221"
                                        >
                                            <div className="Pixso-frame-16_221" style={{ position: "relative", overflow: "hidden" }}>
                                                {/* 重新分析：容器右上角 */}
                                                <div
                                                    onClick={isAnalyzing ? undefined : handleExtractAssets}
                                                    style={{ ...headerBtnStyle(isAnalyzing), position: "absolute", top: 14, right: 14, zIndex: 2 }}
                                                    title="重新运行资产拆分（整体替换当前资产）"
                                                >
                                                    <RefreshCw size={15} /> 重新分析
                                                </div>
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
                                                    {/* 标题行：资产提取完成（左） + 继续提取（右，对齐右边） */}
                                                    <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", gap: 12, width: "100%" }}>
                                                        <p
                                                            id="16_227"
                                                            className="Pixso-paragraph-16_227"
                                                        >
                                                            {isAnalyzing ? "正在提取资产实体..." : (isAnalyzed ? "资产提取完成" : "尚未分析")}
                                                        </p>
                                                        {/* 继续提取：把已提取资产作查重清单喂回模型，只补全剩余、不重复不覆盖 */}
                                                        <div
                                                            onClick={(isAnalyzing || !isAnalyzed) ? undefined : handleContinueExtraction}
                                                            style={headerBtnStyle(isAnalyzing || !isAnalyzed)}
                                                            title="把已提取的资产作为查重清单喂回模型，只补全剩余资产（不重复、不覆盖已有），可反复点击直到无新增"
                                                        >
                                                            <ListPlus size={15} /> 继续提取
                                                        </div>
                                                    </div>
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

                                                    {/* 实体统计卡（6 项 2 行 3 列：大号数字 + 右侧大图标填充空白） */}
                                                    <div style={{ display: "grid", gridTemplateColumns: "repeat(3, 1fr)", gap: 16, marginTop: 12, width: "100%" }}>
                                                        {([
                                                            { label: "角色", count: characters.length, desc: isAnalyzed ? "源于剧本自动识别" : "未识别角色", Icon: User, accent: "#a78bfa" },
                                                            { label: "场景", count: scenes.length, desc: "覆盖的场景数量", Icon: ImageIcon, accent: "#60a5fa" },
                                                            { label: "物品", count: items.length, desc: "关键道具数量", Icon: Package, accent: "#f5c451" },
                                                            { label: "生物", count: organisms.length, desc: "涉及的动物/生物", Icon: PawPrint, accent: "#34d399" },
                                                            { label: "群像", count: crowds.length, desc: isAnalyzed ? "阵营/群体数量" : "未识别群像", Icon: Users, accent: "#f472b6" },
                                                            { label: "分集", count: episodes.length, desc: isAnalyzed ? "脚本可识别的分集总量" : "未分集", Icon: Clapperboard, accent: "#22d3ee" },
                                                        ] as const).map((c) => {
                                                            const BigIcon = c.Icon;
                                                            return (
                                                                <div key={c.label} style={{ position: "relative", overflow: "hidden", padding: "16px 18px", borderRadius: 12, background: "rgba(255,255,255,0.03)", border: "1px solid rgba(255,255,255,0.08)" }}>
                                                                    {/* 右侧大号装饰图标，填充原本空旷的右半区 */}
                                                                    <BigIcon size={66} color={c.accent} strokeWidth={1.5} style={{ position: "absolute", right: -6, bottom: -8, opacity: 0.14, pointerEvents: "none" }} />
                                                                    <div style={{ display: "flex", alignItems: "center", gap: 8, position: "relative", zIndex: 1 }}>
                                                                        <BigIcon size={16} color={c.accent} />
                                                                        <span style={{ fontSize: 13, fontWeight: 600, color: "rgba(255,255,255,0.85)" }}>{c.label}</span>
                                                                    </div>
                                                                    <div style={{ fontSize: 34, fontWeight: 800, lineHeight: 1.1, color: "#fff", margin: "10px 0 4px", position: "relative", zIndex: 1 }}>{c.count}</div>
                                                                    <div style={{ fontSize: 11, color: "rgba(255,255,255,0.45)", position: "relative", zIndex: 1 }}>{c.desc}</div>
                                                                </div>
                                                            );
                                                        })}
                                                    </div>
                                                </div>
                                            </div>
                                            <div className="stroke-16_226"></div>
                                        </div>

                                        {/* 项目视觉圣经：全局风格 / 全局色调 / 全局反向提示词（资产提取产出，三栏布局，可编辑） */}
                                        <div style={{ width: "100%", boxSizing: "border-box", marginBottom: 16, padding: 18, borderRadius: 14, background: "linear-gradient(135deg, rgba(139,92,246,0.10) 0%, rgba(255,255,255,0.03) 45%)", border: "1px solid rgba(139,92,246,0.22)", boxShadow: "0 6px 24px rgba(0,0,0,0.18)" }}>
                                            <div style={{ display: "flex", alignItems: "center", gap: 10, marginBottom: 14 }}>
                                                <span style={{ width: 6, height: 18, borderRadius: 3, background: "linear-gradient(180deg, #a78bfa, #8b5cf6)", flexShrink: 0 }} />
                                                <span style={{ fontSize: 15, fontWeight: 700, color: "#fff", letterSpacing: 0.3 }}>项目视觉圣经</span>
                                                <span style={{ fontSize: 11, color: "rgba(167,139,250,0.9)", background: "rgba(139,92,246,0.14)", border: "1px solid rgba(139,92,246,0.28)", padding: "2px 9px", borderRadius: 999 }}>全局锚点·所有资产继承，禁止漂移</span>
                                            </div>
                                            <div style={{ display: "grid", gridTemplateColumns: "repeat(3, 1fr)", gap: 14 }}>
                                                {([
                                                    { key: "style", label: "全局风格", accent: "#a78bfa", ph: "如：3D国风动画，院线级非真人化次世代国漫…" },
                                                    { key: "colorSystem", label: "全局色调", accent: "#f5c451", ph: "如：主色青铜绿、阴煞黑、符箓金…" },
                                                    { key: "negativeGlobal", label: "全局反向提示词", accent: "#f87171", ph: "如：禁止真人写实、照片级毛孔、UE5真人扫描脸…" },
                                                ] as const).map((f) => (
                                                    <div key={f.key} style={{ display: "flex", flexDirection: "column", padding: 12, borderRadius: 10, background: "rgba(0,0,0,0.22)", border: `1px solid ${f.accent}33` }}>
                                                        <div style={{ display: "flex", alignItems: "center", gap: 7, marginBottom: 8 }}>
                                                            <span style={{ width: 7, height: 7, borderRadius: "50%", background: f.accent, boxShadow: `0 0 6px ${f.accent}99`, flexShrink: 0 }} />
                                                            <span style={{ fontSize: 12.5, fontWeight: 600, color: "rgba(255,255,255,0.92)" }}>{f.label}</span>
                                                        </div>
                                                        <textarea
                                                            value={visualBible[f.key] || ""}
                                                            onChange={(e) => setVisualBibleStore({ [f.key]: e.target.value })}
                                                            placeholder={f.ph}
                                                            onFocus={(e) => { e.currentTarget.style.borderColor = `${f.accent}99`; e.currentTarget.style.boxShadow = `0 0 0 2px ${f.accent}22`; }}
                                                            onBlur={(e) => { e.currentTarget.style.borderColor = "rgba(255,255,255,0.08)"; e.currentTarget.style.boxShadow = "none"; }}
                                                            style={{ width: "100%", minHeight: 132, resize: "vertical", boxSizing: "border-box", padding: "9px 11px", borderRadius: 8, background: "rgba(0,0,0,0.35)", border: "1px solid rgba(255,255,255,0.08)", color: "#fff", fontSize: 12, lineHeight: 1.6, outline: "none", transition: "border-color 0.15s, box-shadow 0.15s" }}
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
