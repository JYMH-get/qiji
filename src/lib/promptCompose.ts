/**
 * promptCompose — 提示词胶囊的「规范顺序」组合（画布图片/视频节点）。
 *
 * 规范默认顺序（前 → 后）：
 *   【素材图例】 → 预设前缀胶囊 → 上游文本胶囊 → 用户输入正文 → 预设后缀胶囊
 * 这些只是**默认落位**；用户可长按拖动预设/上游胶囊改变实际位置（提交按实际顺序展开）。
 *
 * 本模块只负责「自动插入时的默认落位」（纯字符串函数，便于单测）：
 *  - insertPresetCapsule：按预设 position 落到 正文最前（前缀）/ 最后（后缀），并移除同组/同 id 旧胶囊（互斥）；
 *  - placeUpstreamCapsules：把 1..n 上游胶囊落在 图例 + 前缀预设 之后、用户正文之前。
 */
import { PRESET_TAG_RE, presetTag, presetGroup, presetPosition } from "@/lib/presetSchemes";
import { buildUpstreamCapsuleBlock, stripUpstreamCapsules } from "@/lib/upstreamText";
import { splitLegendPrompt } from "@/lib/shotMaterials";

/** 按逐资产说明文法拆出图例与正文；无图例则 legend=""。 */
function splitLegend(prompt: string): { legend: string; body: string } {
	const { legend, body } = splitLegendPrompt(prompt);
	return { legend, body };
}

function joinLegend(legend: string, body: string): string {
	if (!legend) return body;
	return body ? `${legend}\n\n${body}` : legend;
}

/** 正文开头「前缀预设胶囊」连续段的结束下标（跳过前导 空白 + position=prefix 的预设胶囊） */
function leadingPrefixPresetEnd(body: string): number {
	let i = 0;
	const re = /^\s*【预设:([A-Za-z0-9._-]+)】/;
	// eslint-disable-next-line no-constant-condition
	while (true) {
		const m = re.exec(body.slice(i));
		if (!m) break;
		if (presetPosition(m[1]) !== "prefix") break; // 后缀预设即便在前也不跳过
		i += m[0].length;
	}
	return i;
}

/** 移除提示词里所有匹配 pred(id) 的预设胶囊 */
function removePresets(text: string, pred: (id: string) => boolean): string {
	return text.replace(new RegExp(PRESET_TAG_RE.source, "g"), (m, id: string) => (pred(id) ? "" : m))
		.replace(/\n{3,}/g, "\n\n");
}

/**
 * 插入一枚预设胶囊到规范默认位置：
 *  - 先移除同互斥组的其它预设胶囊 + 自身已有胶囊（互斥 + 去重）；
 *  - position=prefix → 落到正文最前（图例之后、其余正文之前）；suffix → 落到正文最后。
 */
export function insertPresetCapsule(prompt: string, id: string): string {
	const grp = presetGroup(id);
	let text = removePresets(prompt || "", (pid) => pid === id || (!!grp && presetGroup(pid) === grp));
	const { legend, body } = splitLegend(text);
	const clean = body.trim();
	const marker = presetTag(id);
	const newBody = presetPosition(id) === "suffix"
		? (clean ? `${clean}\n${marker}` : marker)
		: (clean ? `${marker}\n${clean}` : marker);
	return joinLegend(legend, newBody);
}

/**
 * 把上游文本胶囊设为恰好 1..n（幂等）：落在 图例 + 前缀预设 之后、用户正文之前。n<=0 时仅剥离。
 */
export function placeUpstreamCapsules(prompt: string, n: number): string {
	const stripped = stripUpstreamCapsules(prompt || "");
	if (n <= 0) return stripped;
	const { legend, body } = splitLegend(stripped);
	const end = leadingPrefixPresetEnd(body);
	const before = body.slice(0, end).replace(/\s+$/, "");
	const after = body.slice(end).replace(/^\s+/, "");
	const block = buildUpstreamCapsuleBlock(n);
	const newBody = [before, block, after].filter(Boolean).join("\n");
	return joinLegend(legend, newBody);
}
