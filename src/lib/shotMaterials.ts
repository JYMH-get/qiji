// ── 分镜素材模态（图像/视频/音频）+ @tag 编号工具（视图与提示词编辑器共用）──
// 资产库素材恒为图像；本地上传按文件类型判定。tag 编号 = 同模态分组内 1-based 序号，
// 须与发往上游的 images/videos/audios 数组顺序一致（后台据此把名字替换成「名字@ImageN 」等）。
import type { ShotMaterial } from "@/services/projectFile";

export type MediaKind = "image" | "video" | "audio";

export const mediaOf = (m: ShotMaterial): MediaKind => (m.media as MediaKind) || "image";

/** 模型规范的 @tag 关键字（实际请求用这套：@Image1 / @Video1 / @Audio1） */
export const TAG_KIND: Record<MediaKind, string> = { image: "Image", video: "Video", audio: "Audio" };
/** 缩略图角标字母 */
export const TAG_BADGE: Record<MediaKind, string> = { image: "I", video: "V", audio: "A" };
/** 角标/胶囊配色（按模态） */
export const BADGE_BG: Record<MediaKind, string> = {
    image: "rgba(59,130,246,0.85)",
    video: "rgba(139,92,246,0.9)",
    audio: "rgba(16,185,129,0.9)",
};

export const mediaFromMime = (mime: string): MediaKind =>
    mime.startsWith("video/") ? "video" : mime.startsWith("audio/") ? "audio" : "image";

/** 计算每个素材的 @tag（materialId → "@Image1"；与上游数组顺序对齐） */
export function materialTags(materials: ShotMaterial[]): Record<string, string> {
    const c: Record<MediaKind, number> = { image: 0, video: 0, audio: 0 };
    const out: Record<string, string> = {};
    for (const m of materials) {
        const md = mediaOf(m);
        c[md] += 1;
        out[m.id] = `@${TAG_KIND[md]}${c[md]}`;
    }
    return out;
}

/** 反查：tag（"@Image1"）→ 素材，供提示词里把 @tag 渲染成带缩略图的胶囊 */
export function tagToMaterial(materials: ShotMaterial[]): Map<string, ShotMaterial> {
    const tags = materialTags(materials);
    const map = new Map<string, ShotMaterial>();
    for (const m of materials) map.set(tags[m.id], m);
    return map;
}

/** 匹配 prompt 里的 @tag（@Image1/@Video12/@Audio3…），全局用 */
export const MENTION_TAG_RE = /@(?:Image|Video|Audio)\d+/g;

// ── 提示词后处理（视图与 generationQueue 共用：推理结果清洗 + 素材图例前缀）──

/**
 * 把「提示词推理」LLM 输出解析为干净的提示词正文。
 * 视频提示词模板常返回 [{id,duration,visualDescription}] JSON，直接落框会带 [、"id"、转义换行等标记。
 * 这里剥掉 JSON 外壳与转义（JSON.parse 自动还原 \n/\"），取 visualDescription 多卡用空行串接；
 * 保留 {角色:}{场景:}{音频:} 公式；非 JSON（纯文本）原样返回。容忍「先思考过程、后 JSON」。
 */
export function extractPromptText(text: string): string {
    const raw = (text || "").trim();
    if (!raw) return "";
    const pick = (o: any): string =>
        String(
            o?.visualDescription ?? o?.dynamicVideoPrompt ?? o?.videoPrompt ??
            o?.imagePrompt ?? o?.prompt ?? o?.scriptContent ?? "",
        ).trim();
    const candidates: string[] = [];
    if (raw.startsWith("[") || raw.startsWith("{")) candidates.push(raw);
    const fence = raw.match(/```(?:json)?\s*([\s\S]*?)```/i);
    if (fence) candidates.push(fence[1].trim());
    const la = raw.indexOf("["), lb = raw.lastIndexOf("]");
    if (la >= 0 && lb > la) candidates.push(raw.slice(la, lb + 1));
    const oa = raw.indexOf("{"), ob = raw.lastIndexOf("}");
    if (oa >= 0 && ob > oa) candidates.push(raw.slice(oa, ob + 1));
    for (const c of candidates) {
        try {
            const obj = JSON.parse(c);
            const arr: any[] = Array.isArray(obj) ? obj : Array.isArray(obj?.shots) ? obj.shots : [obj];
            const parts = arr.map(pick).filter(Boolean);
            if (parts.length) return parts.join("\n\n");
        } catch { /* 试下一个候选 */ }
    }
    return raw; // 非 JSON（纯文本提示词）→ 原样返回
}

/** 图例块前缀标识（提取资产写入提示词的「@ImageN 是 资产名；」前缀，可被再次提取/推理刷新而不重复堆叠） */
export const LEGEND_START = "【素材图例】";
/** 构建图例：「@Image1 是 张起灵；…」单行（imagesOnly=true 仅图像，供故事板提示词用）。
 *  「@X 是 名」是图像/视频用的格式；音频**不**产出该条目，只以「角色↔声音参考」配对出现：
 *  `@Image1的声音参考@Audio1`（音频素材带 voiceForAssetId 指向角色），避免前缀重复。 */
export function buildLegend(materials: ShotMaterial[], imagesOnly: boolean): string {
    const tags = materialTags(materials);
    const entries = materials
        .filter((m) => m.name && (imagesOnly ? mediaOf(m) === "image" : mediaOf(m) !== "audio"))
        .map((m) => `${tags[m.id]} 是 ${m.name}`);
    if (!imagesOnly) {
        // 角色声音参考配对：把绑定到角色的音频与该角色的图像 tag 关联，写「@ImageN的声音参考@AudioM」
        const imgByAsset = new Map<string, ShotMaterial>();
        for (const m of materials) if (mediaOf(m) === "image" && m.assetId) imgByAsset.set(m.assetId, m);
        for (const m of materials) {
            if (mediaOf(m) !== "audio" || !m.voiceForAssetId) continue;
            const img = imgByAsset.get(m.voiceForAssetId);
            if (img) entries.push(`${tags[img.id]}的声音参考${tags[m.id]}`);
        }
    }
    return entries.length ? `${LEGEND_START}${entries.join("；")}；` : "";
}

export interface LegendEntry {
    /** 资产说明按 @tag 唯一；声音参考按图像/音频 tag 对唯一。 */
    key: string;
    /** 不含末尾分隔符，保留用户改过的「是 xxx」说明。 */
    text: string;
}

export interface LegendPromptParts {
    legend: string;
    body: string;
    entries: LegendEntry[];
}

const DESC_HEAD_RE = /^(@(?:Image|Video|Audio)\d+)\s*是\s*/;
const VOICE_ENTRY_RE = /^(@Image\d+)\s*的声音参考\s*(@Audio\d+)/;
const NEW_ENTRY_SEPARATOR_RE = /[；;]/;
const LEGACY_ENTRY_SEPARATOR_RE = /[，,。\r\n]/;
type LegendSeparator = "semicolon" | "legacy-comma";

function entryAt(text: string, start: number, separator: LegendSeparator): { entry: LegendEntry; end: number } | null {
    const rest = text.slice(start);
    const voice = VOICE_ENTRY_RE.exec(rest);
    if (voice) {
        return {
            entry: { key: `voice:${voice[1]}:${voice[2]}`, text: voice[0].trim() },
            end: start + voice[0].length,
        };
    }
    const desc = DESC_HEAD_RE.exec(rest);
    if (!desc) return null;
    const valueStart = start + desc[0].length;
    const relEnd = text.slice(valueStart).search(
        separator === "semicolon" ? NEW_ENTRY_SEPARATOR_RE : LEGACY_ENTRY_SEPARATOR_RE,
    );
    const end = relEnd >= 0 ? valueStart + relEnd : text.length;
    return { entry: { key: `desc:${desc[1]}`, text: text.slice(start, end).trim() }, end };
}

function renderLegend(entries: LegendEntry[]): string {
    return entries.length ? `${LEGEND_START}${entries.map((e) => e.text).join("；")}；` : "";
}

/**
 * 新图例统一用分号划分资产，资产说明里的普通逗号因此可以原样保留。
 * 旧项目仍是逗号格式：只有 marker 所在行出现分号时才按新文法读取，避免正文后续的分号误判格式。
 */
function legendSeparatorOf(text: string, marker: number): LegendSeparator {
    const lineEnd = text.indexOf("\n", marker);
    const legendLine = text.slice(marker + LEGEND_START.length, lineEnd >= 0 ? lineEnd : text.length);
    return NEW_ENTRY_SEPARATOR_RE.test(legendLine) ? "semicolon" : "legacy-comma";
}

/**
 * 按「每个资产一条说明」的文法拆图例，而不是依赖空行。
 * buildLegend 恒在每条说明后写 `；`，所以说明中的普通逗号不会再被误判为资产边界；
 * 同时兼容旧项目的逗号分隔格式。
 */
export function splitLegendPrompt(prompt: string): LegendPromptParts {
    const text = prompt || "";
    const marker = text.indexOf(LEGEND_START);
    if (marker < 0) return { legend: "", body: text, entries: [] };

    const entries: LegendEntry[] = [];
    const separator = legendSeparatorOf(text, marker);
    let cursor = marker + LEGEND_START.length;
    let bodyStart = cursor;
    while (cursor < text.length) {
        while (text[cursor] === " " || text[cursor] === "\t") cursor++;
        const parsed = entryAt(text, cursor, separator);
        if (!parsed) break;
        entries.push(parsed.entry);
        cursor = parsed.end;

        // 每条图例后的分隔符只承担边界作用；若后面紧跟下一条 @ 说明则继续解析，
        // 否则剩余内容就是用户正文（同一行、单换行、空行三种形态都支持）。
        const boundary = separator === "semicolon" ? /[；;]/ : /[，,。]/;
        if (boundary.test(text[cursor] || "")) cursor++;
        let probe = cursor;
        while (text[probe] === " " || text[probe] === "\t") probe++;
        if (entryAt(text, probe, separator)) {
            cursor = probe;
            continue;
        }
        bodyStart = cursor;
        break;
    }

    if (entries.length === 0) {
        // 兼容损坏/旧格式：最多剥掉 marker 所在行，绝不再把「marker 到字符串末尾」整段吞掉。
        const lineEnd = text.indexOf("\n", marker);
        bodyStart = lineEnd >= 0 ? lineEnd + 1 : marker + LEGEND_START.length;
    }
    while (/\s/.test(text[bodyStart] || "")) bodyStart++;
    const before = text.slice(0, marker).trim();
    const after = text.slice(bodyStart).trim();
    const body = before && after ? `${before}\n${after}` : before || after;
    return { legend: renderLegend(entries), body, entries };
}

/** 剥掉提示词里的旧「素材图例」条目，返回用户正文（含内联 @ 引用）。 */
export function stripLegend(prompt: string): string {
    return splitLegendPrompt(prompt).body;
}

/** 把图例并入 prompt 前缀；已有资产说明逐条保留，只补本次缺失的条目。 */
export function withLegend(prompt: string, legend: string): string {
    return applyLegend(prompt, legend);
}

/**
 * 素材**重排**后把图例与正文里的 @ 引用按「旧 tag → 新 tag」映射整体置换；
 * 随后的 applyLegend 会按新 tag 保留对应资产说明。
 * String.replace 单次扫描：置换结果不会被二次匹配，交换类映射（@Image1↔@Image3）不串连改写；映射外的 tag 原样保留。
 */
export function remapBodyTags(prompt: string, mapping: Record<string, string>): string {
    if (!prompt || Object.keys(mapping).length === 0) return prompt || "";
    return prompt.replace(new RegExp(MENTION_TAG_RE.source, "g"), (tag) => mapping[tag] ?? tag);
}

/**
 * 删除素材后同步修正**正文里的内联 @ 引用**（不含图例块——图例块由 buildLegend 整体重建，不在这里改）：
 *  - 被删素材的 `@KindN` 引用移除（连同紧邻的一个顿号/逗号）；
 *  - 其后同媒体编号整体前移（@Image3→@Image2），与素材区重编号一致。
 */
export function renumberBodyRefs(prompt: string, media: MediaKind, removedN: number): string {
    const kind = TAG_KIND[media];
    return prompt.replace(new RegExp(`@${kind}(\\d+)([、，,]?)`, "g"), (m, num: string, sep: string) => {
        const n = Number(num);
        if (n === removedN) return "";
        if (n > removedN) return `@${kind}${n - 1}${sep}`;
        return m;
    });
}

/**
 * 素材增删后统一同步图例（画布/资产模式共用）：
 *  1) 按条拆旧图例与正文；2) 删除时移除/重编号对应说明及正文 @ 引用；
 *  3) 按 @tag 合并当前素材图例——已有说明保留用户文本，只为新资产补缺失说明。
 * legend 由调用方按当前素材集 buildLegend/buildNodeLegend 得到，作为「当前应有哪些条目」的清单。
 */
export function applyLegend(
    prompt: string,
    legend: string,
    removed?: { media: MediaKind; n: number },
    options?: { preserveExisting?: boolean },
): string {
    const current = splitLegendPrompt(prompt);
    let existing = current.entries;
    if (removed) {
        const kind = TAG_KIND[removed.media];
        const removedTag = new RegExp(`@${kind}${removed.n}(?!\\d)`);
        const renumber = new RegExp(`@${kind}(\\d+)`, "g");
        existing = existing.flatMap((entry) => {
            if (removedTag.test(entry.text)) return [];
            const text = entry.text.replace(renumber, (tag, num: string) => {
                const n = Number(num);
                return n > removed.n ? `@${kind}${n - 1}` : tag;
            });
            const parsed = entryAt(text, 0, "semicolon");
            return parsed ? [parsed.entry] : [];
        });
    }

    let body = current.body;
    if (removed) body = renumberBodyRefs(body, removed.media, removed.n);
    const wanted = splitLegendPrompt(legend).entries;
    const preserved = options?.preserveExisting === false
        ? new Map<string, string>()
        : new Map(existing.map((entry) => [entry.key, entry.text]));
    const merged = wanted.map((entry) => ({ ...entry, text: preserved.get(entry.key) ?? entry.text }));
    const nextLegend = renderLegend(merged);
    if (!nextLegend) return body;
    return body ? `${nextLegend}\n\n${body}` : nextLegend;
}
