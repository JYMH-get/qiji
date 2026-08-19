/**
 * jianyiContext —— 简一助手上下文上限纯逻辑（可单测）。
 *
 * 规则（用户定稿）：
 *  - 会话上下文达 6 万字：提示用户新开窗口；
 *  - 达 8 万字：禁止继续对话，只留两个动作——
 *      【总结本次对话】（总结性语言，落回当前会话）；
 *      【总结至新窗口继续】（提示性语言，预填到新会话输入框）。
 *  - **完整请求**（用户定稿，零采样零截断）：整段对话转录原样作 {{对话内容}} 变量提交
 *    （服务端 bodyLimit 25MB 足够），服务端也不做任何采样/压缩，完整填入模板。
 *  - 两个动作的提示词正文由管理端「提示词模板」维护（templateId 调用，正文不下发客户端；
 *    模板被删时服务端 jianyiSummaryPrompt.ts 代码兜底）。
 */
import type { JyMessage } from "@/store/jianyiAssistantStore";

/** 上下文提示阈值（字符数）：达到即提示新开窗口 */
export const JY_WARN_CHARS = 60000;
/** 上下文封锁阈值（字符数）：达到即禁止继续对话，只留总结按钮 */
export const JY_BLOCK_CHARS = 80000;

/** 管理端模板 id（服务端 templates.ts 补种，正文管理端可调优；同时决定服务端采样权重档） */
export const SUMMARY_TEMPLATE_ID = "jianyi.summary";
export const HANDOFF_TEMPLATE_ID = "jianyi.handoff";

/** 单条消息计入上下文的字符数：正文 + 可读附件正文（都会喂给模型） */
export function messageChars(m: JyMessage): number {
	let n = (m.content ?? "").length;
	for (const f of m.files ?? []) n += f.text?.length ?? 0;
	return n;
}

/** 会话上下文总字符数 */
export function sessionContextChars(msgs: JyMessage[]): number {
	let n = 0;
	for (const m of msgs) n += messageChars(m);
	return n;
}

/** 把整段会话拼成 用户：/助手： 转录（含可读附件正文；完整发送，采样由服务端做） */
export function formatConversation(msgs: JyMessage[]): string {
	const lines = msgs.map((m) => {
		const who = m.role === "user" ? "用户" : "助手";
		let c = m.content || "";
		if (m.role === "user" && m.images?.length) c = `${c}（附带 ${m.images.length} 张图片）`.trim();
		if (m.role === "user" && m.files?.length) {
			const parts = m.files.map((f) =>
				f.text ? `【附件：${f.name}】\n${f.text}\n【附件结束】` : `（附带文件：${f.name}）`,
			);
			c = `${c}\n${parts.join("\n")}`.trim();
		}
		return `${who}：${c}`;
	});
	return lines.join("\n\n");
}
