/**
 * 从 GenerateRequest 拼出喂给文本模型的用户消息（各文本翻译器共用）。
 *
 * 优先级：promptOverride > templateId 正文(权威，填变量) > variables.prompt > 变量兜底拼接。
 * templateId → 管理端模板库正文，{{变量}} 由 req.variables 填充。
 */
import type { GenerateRequest, AssetType } from "../contract.ts";
import { getTemplateDef } from "../store/templates.ts";
import { getVariantPrefix } from "../catalog.ts";

/** asset.{character|scene|creature|prop}.variant → 资产类型 */
const VARIANT_RE = /^asset\.(character|scene|creature|prop)\.variant$/;

/** 用变量填充 {{占位}}；缺失的占位替换为空串 */
export function fillTemplate(body: string, vars: Record<string, string>): string {
	return body.replace(/\{\{\s*([^}]+?)\s*\}\}/g, (_m, name: string) => {
		const key = name.trim();
		const val = vars[key];
		return val != null ? String(val) : "";
	});
}

export function buildPrompt(req: GenerateRequest): string {
	if (req.promptOverride && req.promptOverride.trim()) return req.promptOverride;
	const v = req.variables ?? {};

	// 变体（图生图）：用 catalog 变体前缀"保 DNA 不变"合成（{{变体描述}}{{视觉风格}} 填充）
	const vm = req.purpose?.match(VARIANT_RE);
	if (vm) {
		const prefix = getVariantPrefix(vm[1] as AssetType);
		if (prefix) {
			const composed = fillTemplate(prefix.prefix, v as Record<string, string>);
			const base = typeof v.prompt === "string" && v.prompt.trim() ? `\n底图描述：${v.prompt}` : "";
			return composed + base;
		}
	}

	// 模板正文权威：有 templateId 且正文非空 → 取管理端正文并填变量
	if (req.templateId) {
		const tpl = getTemplateDef(req.templateId);
		if (tpl && tpl.body.trim()) return fillTemplate(tpl.body, v as Record<string, string>);
	}

	if (typeof v.prompt === "string" && v.prompt.trim()) return v.prompt;
	if (typeof v.原文 === "string" && v.原文.trim()) {
		const parts = [`视觉风格：${v.视觉风格 ?? ""}`, `原文：\n${v.原文}`];
		if (v.历史资产) parts.push(`历史资产：\n${v.历史资产}`);
		return parts.join("\n\n");
	}
	const texts = req.inputs?.texts ?? [];
	if (texts.length) return texts.map((t) => t.url ?? t.id ?? "").filter(Boolean).join("\n");
	return JSON.stringify(v);
}
