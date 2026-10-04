import type { ShotMaterial } from "@/services/projectFile";
import { matchAssetsInText } from "@/lib/assetMatch";
import { findProjectAssetByImage } from "@/lib/projectAssets";
import { useProjectStore } from "@/store/projectStore";
import { applyLegend, buildLegend, materialTags, MENTION_TAG_RE, splitLegendPrompt } from "@/lib/shotMaterials";

export type MaterialPromptMode = "legend" | "inline" | "both";
export interface MaterialPromptState {
    mode: MaterialPromptMode;
    /** 保留引用身份与原始人名，正文仍保存可逆的人名文本；展示和提交共用转换结果。 */
    retained: ShotMaterial[];
    previous: ShotMaterial[];
}
export const MATERIAL_PROMPT_LABELS = { legend: "图例前缀", inline: "正文替换", both: "图例＋正文" };
export function materialPromptState(value: unknown): MaterialPromptState | undefined {
    const s = value as MaterialPromptState | undefined;
    return s && ["legend", "inline", "both"].includes(s.mode) ? { ...s, retained: s.retained ?? [], previous: s.previous ?? [] } : undefined;
}
export function nextMaterialPromptMode(mode: MaterialPromptMode): MaterialPromptMode {
    return mode === "legend" ? "inline" : mode === "inline" ? "both" : "legend";
}
function entityId(mat: ShotMaterial): string | undefined {
    const s = useProjectStore.getState();
    const asset = mat.assetId && [...s.characters, ...s.crowds, ...s.scenes, ...s.organisms, ...s.items]
        .find(a => a.id === mat.assetId || a.variants?.some(v => v.id === mat.assetId));
    return asset ? asset.id : findProjectAssetByImage(mat.uri)?.assetId;
}
function byEntity(materials: ShotMaterial[]) {
    const tags = materialTags(materials);
    const map = new Map<string, { mat: ShotMaterial; tag: string }>();
    for (const mat of materials) {
        if (mat.media && mat.media !== "image") continue;
        const id = entityId(mat);
        if (id && !map.has(id)) map.set(id, { mat, tag: tags[mat.id] });
    }
    return map;
}
export interface MaterialPromptToken { start: number; end: number; original: string; tag?: string; material: ShotMaterial }
export function materialPromptTokens(text: string, materials: ShotMaterial[], state?: MaterialPromptState): MaterialPromptToken[] {
    if (!state || state.mode === "legend") return [];
    const current = byEntity(materials);
    const candidates = state.mode === "inline" ? new Map([...byEntity(state.retained), ...current]) : current;
    if (!candidates.size) return [];
    const { body } = splitLegendPrompt(text);
    const offset = body ? text.lastIndexOf(body) : text.length;
    const tokens: MaterialPromptToken[] = [];
    matchAssetsInText(body, (id, start, end) => {
        const item = candidates.get(id);
        if (!item) return;
        // 不二次替换用户已输入的 @ 引用。
        if (start > 0 && body[start - 1] === "@") return;
        tokens.push({ start: start + offset, end: end + offset, original: body.slice(start, end), tag: current.get(id)?.tag, material: item.mat });
    });
    return tokens.sort((a, b) => a.start - b.start);
}

/** 保存原文，展示为资产胶囊；发出请求时才按当次素材顺序输出 @ImageN，失效引用保留人名。 */
export function compileMaterialPrompt(text: string, materials: ShotMaterial[], state?: MaterialPromptState): string {
    let result = text;
    for (const token of materialPromptTokens(text, materials, state).reverse()) {
        result = result.slice(0, token.start) + (token.tag || token.original) + result.slice(token.end);
    }
    return result;
}

export function syncMaterialPrompt(text: string, materials: ShotMaterial[], state: MaterialPromptState, mode = state.mode): { prompt: string; state: MaterialPromptState } {
    const old = state.previous.length ? state.previous : materials;
    const oldTags = materialTags(old);
    const names = new Map(old.map(m => [oldTags[m.id], m.name]));
    const parts = splitLegendPrompt(text);
    // 显式手输 @ 引用也先绑定旧编号的人名，避免删掉 I1 后原 I2 被错认成新 I2。
    const body = parts.body.replace(new RegExp(MENTION_TAG_RE.source, "g"), tag => names.get(tag) || tag);
    const withBody = parts.legend ? `${parts.legend}\n\n${body}` : body;
    const tags = materialTags(materials);
    const previousByTag = new Map(old.map(m => [oldTags[m.id], m.assetId || m.uri || m.id]));
    const stableTags = materials.every(m => !previousByTag.has(tags[m.id]) || previousByTag.get(tags[m.id]) === (m.assetId || m.uri || m.id));
    const prompt = mode === "inline" ? body : applyLegend(withBody, buildLegend(materials, false), undefined, { preserveExisting: stableTags });
    const retained = mode === "inline" ? [...new Map([...state.retained, ...materials].map(m => [entityId(m) || m.id, m])).values()] : materials;
    return { prompt, state: { mode, retained, previous: materials } };
}
