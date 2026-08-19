/**
 * smartInferPrompts —— 「智能推理」模板 id 常量 + 输出解析（cards）。
 *
 * 智能推理 = 一次调用同时产出：剧集分镜(original_script) + 故事板提示词(storyboard_prompts) + 视频提示词(video_prompts)。
 *
 * 提示词正文**不在客户端**（遵循"提示词必须服务端保存、客户端调用"原则）：
 * 权威正文存管理端 `server/data/templates.json`（源 `skills/分镜2视频/智能推理-{多,单}分镜.md`），
 * 经 `/v1/catalog` 下发，客户端只按 `templateId` + `variables{原文}` 调用 `runPurpose`。
 * 本文件仅保留：模板 id 常量 + 输出解析（不含任何提示词正文）。
 *
 * ⚠ 解析容错说明：模型输出的字段值是超长多行文本，且强制包含台词公式
 * `{音频:角色名}的音色用[情绪]:"台词内容"`（**半角双引号**）与 `{角色:名}`/`{场景:名}`（**花括号**），
 * 故几乎必然产出「人眼正常、但 JSON.parse 拒绝」的串（字符串内裸换行 / 未转义引号 / 字面花括号）。
 * 因此除严格 JSON 快路径外，提供 `extractCardsLoose`：**不依赖整体 JSON 合法**，
 * 仅靠已知字段 key 定位 + 引号闭合启发式抽取字段值，且支持**未闭合的流式部分卡**（边出边填）。
 */

/** 智能推理·多分镜 模板 id（正文：管理端 templates.json / skills/分镜2视频/智能推理-多分镜.md） */
export const SMART_INFER_MULTI_TPL = "smart.infer.multi";
/** 智能推理·单分镜 模板 id（正文：管理端 templates.json / skills/分镜2视频/智能推理-单分镜.md） */
export const SMART_INFER_SINGLE_TPL = "smart.infer.single";
/** 智能拆分 模板 id（只拆原文不推理；该 id 服务端若无，会按 purpose=storyboard.split 回退到管理端默认模板——与视频页智能拆分同链路） */
export const SMART_SPLIT_TPL = "storyboard.split.smart";
/** 图视同源·多分镜 模板 id（每卡产出一段同源提示词 unified_prompt；正文：管理端 templates.json / skills/分镜2视频/图视同源-多分镜.md） */
export const SMART_INFER_UNIFIED_TPL = "smart.infer.unified";
/** 图视同源·单分镜 模板 id（单卡产出一段同源提示词；正文：管理端 templates.json / skills/分镜2视频/图视同源-单分镜.md） */
export const SMART_INFER_UNIFIED_SINGLE_TPL = "smart.infer.unified.single";

export interface InferCard {
	title: string;
	/** 该分镜时长（秒）；模板产出 duration 字段时解析（数字或 "3.0秒"/"3s" 均可），缺失=undefined */
	duration?: number;
	/** 该分镜原剧本内容 */
	script: string;
	/** 宫格故事板绘图提示词 */
	storyboardPrompt: string;
	/** 影视级视听视频提示词 */
	videoPrompt: string;
	/** 图视同源提示词（图片与视频共用同一段；图视同源模板产出，dual 模板留空） */
	unifiedPrompt: string;
}

/** 从任意形态的时长值里抽秒数（3 / 3.0 / "3.0秒" / "3s"）；抽不出/非正数返回 undefined */
function parseDuration(v: unknown): number | undefined {
	if (v === null || v === undefined) return undefined;
	const m = String(v).match(/\d+(?:\.\d+)?/);
	if (!m) return undefined;
	const n = Number(m[0]);
	return n > 0 ? n : undefined;
}

function toCard(o: any, i: number): InferCard {
	return {
		title: String(o?.card_number ?? o?.cardNumber ?? `第${i + 1}卡`).trim(),
		duration: parseDuration(o?.duration ?? o?.durationSec ?? o?.duration_sec),
		script: String(o?.original_script ?? o?.script ?? o?.scriptContent ?? "").trim(),
		storyboardPrompt: String(o?.storyboard_prompts ?? o?.storyboardPrompts ?? o?.storyboard ?? "").trim(),
		videoPrompt: String(o?.video_prompts ?? o?.videoPrompts ?? o?.video ?? "").trim(),
		unifiedPrompt: String(o?.unified_prompt ?? o?.unifiedPrompt ?? o?.["同源提示词"] ?? o?.prompt ?? "").trim(),
	};
}

// ───────────────────────── 容错抽取（不依赖 JSON.parse）─────────────────────────

type RawField = "card" | "duration" | "script" | "storyboard" | "video" | "unified";
interface RawCard { card?: string; duration?: string; script?: string; storyboard?: string; video?: string; unified?: string }

const KEY_MAP: Record<string, RawField> = {
	card_number: "card", cardNumber: "card",
	duration: "duration", durationSec: "duration", duration_sec: "duration",
	original_script: "script", scriptContent: "script", script: "script",
	storyboard_prompts: "storyboard", storyboardPrompts: "storyboard", storyboard: "storyboard",
	video_prompts: "video", videoPrompts: "video", video: "video",
	unified_prompt: "unified", unifiedPrompt: "unified", 同源提示词: "unified", prompt: "unified",
};
// 匹配 `"<key>"\s*:\s*("?)`——值的开引号**可选**（duration/card_number 可能是裸数字）。
// 长别名在前，避免 storyboard 抢 storyboard_prompts、duration 抢 duration_sec、unified_prompt 抢 prompt。
const KEY_RE = /"(card_number|cardNumber|original_script|scriptContent|script|storyboard_prompts|storyboardPrompts|storyboard|video_prompts|videoPrompts|video|unified_prompt|unifiedPrompt|同源提示词|prompt|duration_sec|durationSec|duration)"\s*:\s*("?)/g;

/** 把 JSON 风格的转义还原成真实字符（单遍）：\n→换行 \t→制表 \"→引号 \\→反斜杠 等。 */
function unescapeJsonish(s: string): string {
	return s.replace(/\\(["\\/nrtbf])/g, (_, c: string) =>
		(({ n: "\n", r: "", t: "\t", b: "", f: "", '"': '"', "/": "/", "\\": "\\" } as Record<string, string>)[c] ?? c),
	);
}

/**
 * 从 start 起找字段值的**真实闭合引号**位置：该引号未被转义、且其后（忽略空白）是 `,`/`}`/`]` 或文末。
 * 找不到（流式尚未闭合）返回 null。
 * 注：值内的台词引号 `"…"` 后通常跟正文而非分隔符，故不会误判为闭合；
 * 若台词正好以 `",`/`"}` 结尾会被提前截断 —— 属可接受的边角误差（人工删改）。
 */
function findValueEnd(text: string, start: number): number | null {
	for (let i = start; i < text.length; i++) {
		if (text[i] !== '"') continue;
		let bs = 0, p = i - 1;
		while (p >= start && text[p] === "\\") { bs++; p--; }
		if (bs % 2 === 1) continue; // 被转义的引号，跳过
		let j = i + 1;
		while (j < text.length && /\s/.test(text[j])) j++;
		if (j >= text.length || text[j] === "," || text[j] === "}" || text[j] === "]") return i;
	}
	return null;
}

/**
 * 容错抽取 cards：不依赖整体 JSON 合法，仅靠已知字段 key 定位字段值。
 * - 支持**未闭合的最后一张卡**（其末字段值取到文末作部分内容）→ 流式边出边填。
 * - 新卡判定：遇到 `card_number` 字段，或当前卡该字段已存在 → 开新卡。
 */
export function extractCardsLoose(text: string): InferCard[] {
	const t = text || "";
	const matches: { field: RawField; valStart: number; matchStart: number; quoted: boolean }[] = [];
	KEY_RE.lastIndex = 0;
	let m: RegExpExecArray | null;
	while ((m = KEY_RE.exec(t))) {
		const field = KEY_MAP[m[1]];
		if (field) matches.push({ field, valStart: KEY_RE.lastIndex, matchStart: m.index, quoted: m[2] === '"' });
	}
	const raws: RawCard[] = [];
	let cur: RawCard | null = null;
	let guard = -1; // 已消费到的位置；落在上一字段值内部的 key 命中要跳过
	for (const mt of matches) {
		if (mt.matchStart < guard) continue;
		let raw: string;
		if (mt.quoted) {
			const end = findValueEnd(t, mt.valStart);
			raw = end === null ? t.slice(mt.valStart) : t.slice(mt.valStart, end);
			guard = end === null ? t.length : end + 1;
		} else {
			// 裸值（duration/card_number 的数字）：取到 ,/}/]/换行 为止
			const seg = t.slice(mt.valStart);
			const stop = seg.search(/[,}\]\r\n]/);
			raw = stop === -1 ? seg : seg.slice(0, stop);
			guard = mt.valStart + (stop === -1 ? seg.length : stop);
		}
		const val = unescapeJsonish(raw.replace(/\s+$/, ""));
		if (cur && (mt.field === "card" || cur[mt.field] !== undefined)) { raws.push(cur); cur = null; }
		if (!cur) cur = {};
		cur[mt.field] = val;
	}
	if (cur) raws.push(cur);
	return raws
		.map((r, i): InferCard => ({
			title: (r.card || `第${i + 1}卡`).trim(),
			duration: parseDuration(r.duration),
			script: (r.script || "").trim(),
			storyboardPrompt: (r.storyboard || "").trim(),
			videoPrompt: (r.video || "").trim(),
			unifiedPrompt: (r.unified || "").trim(),
		}))
		.filter((c) => c.title || c.script || c.storyboardPrompt || c.videoPrompt || c.unifiedPrompt);
}

/**
 * 流式增量解析：边出边填——已出现的字段立即体现，**不强制整卡闭合**。
 * 直接用容错抽取（含未闭合的尾卡部分字段），故 `card_number` 一出就建行、`original_script` 一出就填原文…
 */
export function parseInferCardsStream(text: string): InferCard[] {
	return extractCardsLoose(text);
}

/**
 * 解析智能推理最终输出 → InferCard[]。
 * 先试严格 JSON（最准，容忍代码块/前后噪声/单对象）；全部失败再退回容错抽取（裸换行/未转义引号/字面花括号）。
 */
export function parseInferCards(text: string): InferCard[] {
	const t = (text || "").trim();
	const candidates: string[] = [];
	if (t.startsWith("[") || t.startsWith("{")) candidates.push(t);
	const fence = t.match(/```(?:json)?\s*([\s\S]*?)```/i);
	if (fence) candidates.push(fence[1].trim());
	const la = t.indexOf("["), lb = t.lastIndexOf("]");
	if (la >= 0 && lb > la) candidates.push(t.slice(la, lb + 1));
	const oa = t.indexOf("{"), ob = t.lastIndexOf("}");
	if (oa >= 0 && ob > oa) candidates.push(t.slice(oa, ob + 1));

	for (const c of candidates) {
		try {
			const obj = JSON.parse(c);
			const arr: any[] = Array.isArray(obj) ? obj : Array.isArray(obj?.cards) ? obj.cards : [obj];
			const out = arr.map((o, i) => toCard(o, i)).filter((card) => card.script || card.storyboardPrompt || card.videoPrompt || card.unifiedPrompt);
			if (out.length) return out;
		} catch {
			/* 试下一个候选 */
		}
	}
	// 严格 JSON 全失败 → 容错抽取兜底
	return extractCardsLoose(t);
}
