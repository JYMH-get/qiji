/**
 * promptComposer —— 槽位拆分的落地。
 *
 * 提取 LLM 只产"槽位"；完整出图模板(前缀/排版/镜头/布光/负面约束)存 catalog。
 * 最终 basePrompt = 出图模板.prefix + 按 slotOrder 拼接的槽位 + suffix，确定性合成、不漂移。
 * 变体提示词 = 变体前缀(含占位) 注入 变体描述 + 视觉风格。
 */

import type { CatalogImageTemplate, CatalogVariantPrefix } from "@/contract";

/**
 * 合成基础形象提示词。
 * @param tpl   出图模板（按资产类型 × 画风从 catalog 取）
 * @param slots LLM 产出的槽位（如 { 身份, 年龄, 服装, 主色调 ... }）
 */
export function composeBasePrompt(
	tpl: CatalogImageTemplate,
	slots: Record<string, string>,
): string {
	const middle = tpl.slotOrder
		.map((key) => (slots[key] ?? "").trim())
		.filter(Boolean)
		.join("，");
	return [tpl.prefix.trim(), middle, tpl.suffix.trim()].filter(Boolean).join("\n");
}

/**
 * 合成变体（图生图）提示词。
 * @param prefix 变体前缀（角色/场景/生物/道具 各一套），含 {{变体描述}} {{视觉风格}}
 * @param description 用户/LLM 写的变体描述
 * @param style 视觉风格
 */
export function composeVariantPrompt(
	prefix: CatalogVariantPrefix,
	description: string,
	style: string,
): string {
	return prefix.prefix
		.replace(/\{\{变体描述\}\}/g, description)
		.replace(/\{\{视觉风格\}\}/g, style);
}
