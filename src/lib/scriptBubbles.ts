/**
 * scriptBubbles —— 分镜原文「逐行气泡」纯逻辑（实时剪辑工作台原文栏渲染用，样板=表格模式分镜行原文列观感）。
 *
 * splitScriptBubbles(text)：按行拆（空行跳过），逐行判定：
 *  - action   ：▲/△/（/( 开头 —— 动作/场景描述行（整行浅灰渲染）；
 *  - dialogue ：「人名：台词」/「人名: 台词」——人名 ≤6 字、全中文/字母/数字（着色加粗渲染）；
 *  - plain    ：其余普通行。
 * speakerColor(name)：人名哈希 → 固定调色板（≥8 色、深底可读），同名恒同色。
 *
 * 纯函数零依赖，可单测；渲染层只消费结果，勿在组件里另写判定。
 */

export type ScriptBubbleKind = "action" | "dialogue" | "plain";

export interface ScriptBubble {
	kind: ScriptBubbleKind;
	/** dialogue 行的人名（其余 kind 无） */
	speaker?: string;
	/** 行正文：dialogue=冒号后的台词；action/plain=整行原文 */
	body: string;
}

/** 动作/场景描述行的起始符（▲/△ 为剧本惯用动作标记；全半角左括号=舞台提示） */
const ACTION_LEADS = ["▲", "△", "（", "("];

/** 「人名：台词」——人名 1..6 字、全中文/字母/数字，全半角冒号皆可 */
const SPEAKER_RE = /^([一-龥A-Za-z0-9]{1,6})[：:]\s*(.*)$/;

/** 按行拆原文为气泡（空行跳过；行首尾空白剔除） */
export function splitScriptBubbles(text: string | undefined | null): ScriptBubble[] {
	if (!text) return [];
	const out: ScriptBubble[] = [];
	for (const raw of text.split(/\r?\n/)) {
		const line = raw.trim();
		if (!line) continue;
		if (ACTION_LEADS.some((c) => line.startsWith(c))) {
			out.push({ kind: "action", body: line });
			continue;
		}
		const m = SPEAKER_RE.exec(line);
		if (m) {
			out.push({ kind: "dialogue", speaker: m[1], body: m[2] });
			continue;
		}
		out.push({ kind: "plain", body: line });
	}
	return out;
}

/** 人名调色板（深底可读的亮系 300 档；顺序即哈希槽位，改动会让存量观感换色——只增不改序） */
export const SPEAKER_PALETTE = [
	"#fca5a5", // red
	"#fdba74", // orange
	"#fde047", // yellow
	"#86efac", // green
	"#5eead4", // teal
	"#7dd3fc", // sky
	"#a5b4fc", // indigo
	"#d8b4fe", // purple
	"#f9a8d4", // pink
	"#fda4af", // rose
];

/** 人名 → 稳定颜色（同名恒同色；简单字符码滚动哈希取模调色板） */
export function speakerColor(name: string): string {
	let h = 0;
	for (let i = 0; i < name.length; i++) h = (h * 31 + name.charCodeAt(i)) >>> 0;
	return SPEAKER_PALETTE[h % SPEAKER_PALETTE.length];
}
