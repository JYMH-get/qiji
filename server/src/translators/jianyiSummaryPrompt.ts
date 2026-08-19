/**
 * 简一助手·对话总结提示词渲染（purpose "chat.summarize"，buildPrompt 按 purpose 分支调用）。
 *
 * 第201轮定稿（用户令「取消注意力采样，完整请求」）：客户端发送**完整对话转录**
 * （variables.对话内容，服务端 bodyLimit 25MB 足够），服务端**不做任何采样/截断**，
 * 整段原样填入模板 {{对话内容}}。
 *
 * 主体正文取管理端「提示词模板」库（分类「简一助手」可调优，{{对话内容}} 占位）；
 * 模板被删/清空/禁用时回退代码兜底正文，功能不断（与转视角 viewAnglePrompt 同构）。
 */
import type { GenerateRequest } from "../contract.ts";
import { getTemplateDef } from "../store/templates.ts";

/** 本模块受理的两个模板 id（也是两个按钮动作的路由键） */
export const JIANYI_TEMPLATE_IDS = ["jianyi.summary", "jianyi.handoff"] as const;

/** 代码兜底正文（模板被管理端删除/清空/禁用时使用；与种子正文同语义、更精简） */
const FALLBACK_BODY: Record<string, string> = {
	"jianyi.summary": [
		"下面是一段用户与AI助手的完整对话记录。",
		"请用简洁的中文总结本次对话：1.主题与目标；2.要点与结论；3.已确定的产出；4.未解决的问题。只输出总结正文。",
		"",
		"【对话记录】",
		"{{对话内容}}",
	].join("\n"),
	"jianyi.handoff": [
		"下面是一段用户与AI助手的完整对话记录。用户将新开一个对话窗口继续这项工作。",
		"请生成一段可直接发给新窗口助手的交接提示词：说明背景与已确定的结论、保留必须延续的具体信息（名称/设定/格式约定等），结尾写明接下来要继续做的事。只输出这段提示词本身。",
		"",
		"【对话记录】",
		"{{对话内容}}",
	].join("\n"),
};

/** 本地小填充（不 import prompt.ts 的 fillTemplate，避免模块循环） */
function fill(body: string, vars: Record<string, string>): string {
	return body.replace(/\{\{\s*([^}]+?)\s*\}\}/g, (_m, name: string) => {
		const val = vars[name.trim()];
		return val != null ? String(val) : "";
	});
}

/**
 * 渲染简一助手总结提示词（完整对话原样填入，零采样零截断）。
 * variables.对话内容 缺失/非串 → 返回 null 走 buildPrompt 普通路径。
 */
export function renderJianyiSummaryPrompt(req: GenerateRequest): string | null {
	const v = (req.variables ?? {}) as Record<string, string>;
	const raw = v["对话内容"];
	if (typeof raw !== "string" || !raw.trim()) return null;
	const tplId = req.templateId && (JIANYI_TEMPLATE_IDS as readonly string[]).includes(req.templateId)
		? req.templateId
		: "jianyi.summary";
	const tpl = getTemplateDef(tplId);
	const body = tpl && tpl.enabled !== false && tpl.body.trim() ? tpl.body : FALLBACK_BODY[tplId];
	return fill(body, v);
}
