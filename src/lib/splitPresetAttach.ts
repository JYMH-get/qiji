/**
 * splitPresetAttach —— 资产拆分「前后缀预设化」（第174轮）。
 *
 * 语义（用户定，勿回退成「靠推理产前后缀」）：资产拆分推理只产资产正文提示词；
 * 固定的前后缀改为**预设胶囊**在拆分结果落库时由客户端自动挂上（不消耗 token 不等推理）：
 *  - 【画风前缀】：恒按项目画风（新建项目所选画风预设 id = projectStore.visualStyleId），全类别通用；
 *  - 【类别前后缀】：管理端在预设上勾选「自动附加范围」（autoAttach 含该资产类别），
 *    前缀还是后缀由预设自身 position 决定。
 * 出图提交时由 resolvePresets 把胶囊展开成正文（既有机制）。现有推理提示词一字不动。
 */
import { presetTag, listPresetSchemes, type PresetScheme } from "@/lib/presetSchemes";
import { useProjectStore } from "@/store/projectStore";
import { setAssetPromptDecorator } from "@/lib/canvasSpawn";

/** 资产拆分可附加的类别键（= 项目 store 五类字段名，与服务端 SPLIT_ATTACH_CATS 一致） */
export type SplitAttachCat = "characters" | "crowds" | "scenes" | "organisms" | "items";

/**
 * 纯组装：给资产出图提示词挂预设胶囊。
 * 顺序 = 【画风前缀】【类别前缀…】 正文 【类别后缀…】；幂等——提示词里已含的胶囊 id 不重复挂；
 * 空正文不挂（避免给空资产凭空造出只有胶囊的提示词）。
 */
export function composeAssetPrompt(
	prompt: string,
	ids: { styleId?: string; prefixIds?: string[]; suffixIds?: string[] },
): string {
	const p = prompt || "";
	if (!p.trim()) return p;
	const has = (id: string) => p.includes(presetTag(id));
	const dedupe = (a: string[]) => a.filter((id, i) => a.indexOf(id) === i);
	const pre = dedupe([...(ids.styleId ? [ids.styleId] : []), ...(ids.prefixIds ?? [])]).filter((id) => !has(id));
	const suf = dedupe(ids.suffixIds ?? []).filter((id) => !has(id) && !pre.includes(id));
	if (!pre.length && !suf.length) return p;
	return pre.map(presetTag).join("") + p + suf.map(presetTag).join("");
}

/** 从预设清单解出某类别的自动附加 前缀/后缀 id 列表（按清单序） */
export function autoAttachIdsFor(cat: SplitAttachCat, schemes: PresetScheme[]): { prefixIds: string[]; suffixIds: string[] } {
	const hit = schemes.filter((s) => (s.autoAttach ?? []).includes(cat));
	return {
		prefixIds: hit.filter((s) => (s.position ?? "prefix") === "prefix").map((s) => s.id),
		suffixIds: hit.filter((s) => s.position === "suffix").map((s) => s.id),
	};
}

/**
 * store 版：按当前项目画风 + catalog autoAttach 配置，给某类别资产的出图提示词挂胶囊。
 * 资产拆分合并落库（assetMerge）对每个**新增**资产调用；无可挂项时原样返回零开销。
 * 画风 id 不在当前预设清单里（旧项目/兜底画风/预设被删）→ 不挂画风胶囊（报错优于编造：
 * 未知胶囊提交时不展开、会以标记文本原样发给上游，宁可不挂）。
 */
export function attachSplitPresets(cat: SplitAttachCat, prompt: string): string {
	if (!prompt || !prompt.trim()) return prompt;
	const schemes = listPresetSchemes();
	const rawStyleId = useProjectStore.getState().visualStyleId;
	const styleId = rawStyleId && schemes.some((s) => s.id === rawStyleId) ? rawStyleId : undefined;
	const { prefixIds, suffixIds } = autoAttachIdsFor(cat, schemes);
	if (!styleId && !prefixIds.length && !suffixIds.length) return prompt;
	return composeAssetPrompt(prompt, { styleId, prefixIds, suffixIds });
}

// 画布拆分裂变同尺挂胶囊：本模块加载即向 canvasSpawn 注册装饰器（canvasSpawn 保持纯函数可测、
// 缺省恒等）。⚠ 注册必须在这里而非 pluginRegistry 静态导入——后者在 debouncedSave 的加载链上，
// 静态引本模块（→projectStore→debouncedSave）会形成 TDZ 循环（第174轮 vitest 实测炸）。
setAssetPromptDecorator(attachSplitPresets);
