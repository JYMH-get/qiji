/**
 * storyboardParse —— 「智能拆分 / 分镜拆分」LLM 输出 → 分镜段落（纯函数，无 store 依赖）。
 *
 * 从 Frame161195 的 parseShots 抽出的**纯解析核心**，返回与界面无关的 ShotSegment[]，
 * 供视图（映射为 StoryboardShot）与画布「智能拆分」节点裂变共用，避免逻辑漂移。
 */

import { recoverArrayElements } from "@/lib/jsonRecover";

export interface ShotSegment {
	index: number;
	/** 该分镜承载的原始剧本文本（verbatim，不编造） */
	content: string;
	durationSec?: number;
}

/**
 * 去掉文本中的空行（只含空白的行）。分镜原文「每行=一个分格」外显，空行不是分格：
 * 解析落盘（inferRun cardsToPatch）与分格展示/上下拆（Frame161195）共用，保持行语义一致。
 */
export function stripBlankLines(text: string): string {
	return text
		.split(/\r?\n/)
		.filter((l) => l.trim())
		.join("\n");
}

/** 流式增量解析：从未闭合的 JSON 数组抢救出已完整的分镜元素（边出边显示用，不跑文本兜底） */
export function parseShotSegmentsStream(text: string): ShotSegment[] {
	const num = (x: any): number | undefined => {
		const m = String(x ?? "").match(/\d+(?:\.\d+)?/);
		return m ? Number(m[0]) : undefined;
	};
	return recoverArrayElements(text)
		.map((s: any, i: number) => ({
			index: Number(s?.index) || i + 1,
			content: String(s?.scriptContent || s?.plot || s?.dynamicVideoPrompt || s?.visualDescription || s?.prompt || "").trim(),
			durationSec: num(s?.durationSec) ?? num(s?.duration),
		}))
		.filter((s) => s.content);
}

/**
 * 解析分镜：依次尝试 JSON（storyboard.v1 / 大卡数组）→「第N段」→ Markdown 表格 →
 * 「分镜N」分块 → 整段兜底。返回 ShotSegment[]（content 为空的剔除）。
 */
export function parseShotSegments(text: string): ShotSegment[] {
	const seg = (index: number, content: string, durationSec?: number): ShotSegment => ({
		index,
		content: content.trim(),
		durationSec,
	});
	const num = (x: any): number | undefined => {
		const m = String(x ?? "").match(/\d+(?:\.\d+)?/);
		return m ? Number(m[0]) : undefined;
	};

	// 1) JSON（容忍「先思考过程、再 JSON」：```json``` / 数组 / 对象）
	const candidates: string[] = [];
	{
		const t = text.trim();
		if (t.startsWith("[") || t.startsWith("{")) candidates.push(t);
		const fence = t.match(/```(?:json)?\s*([\s\S]*?)```/i);
		if (fence) candidates.push(fence[1].trim());
		const la = t.indexOf("["), lb = t.lastIndexOf("]");
		if (la >= 0 && lb > la) candidates.push(t.slice(la, lb + 1));
		const oa = t.indexOf("{"), ob = t.lastIndexOf("}");
		if (oa >= 0 && ob > oa) candidates.push(t.slice(oa, ob + 1));
	}
	for (const c of candidates) {
		try {
			const obj = JSON.parse(c);
			const shots = Array.isArray(obj) ? obj : obj.shots;
			if (Array.isArray(shots) && shots.length > 0) {
				const out = shots
					.map((s: any, i: number) =>
						seg(
							Number(s.index) || i + 1,
							String(s.scriptContent || s.plot || s.dynamicVideoPrompt || s.visualDescription || s.prompt || "").trim(),
							num(s.durationSec) ?? num(s.duration),
						),
					)
					.filter((s) => s.content);
				if (out.length > 0) return out;
			}
		} catch {
			/* 试下一个候选 */
		}
	}

	// 2)「第N段」切分
	{
		const segRe = /第\s*(\d+)\s*段/g;
		const segMatches = [...text.matchAll(segRe)];
		if (segMatches.length > 0) {
			const out: ShotSegment[] = [];
			for (let i = 0; i < segMatches.length; i++) {
				const m = segMatches[i];
				const start = m.index ?? 0;
				const end = i + 1 < segMatches.length ? (segMatches[i + 1].index ?? text.length) : text.length;
				const block = text.slice(start, end).trim();
				if (!block) continue;
				const idx = Number(m[1]) || out.length + 1;
				const durM = block.match(/[（(]\s*(\d+(?:\.\d+)?)\s*[-~～至到]\s*(\d+(?:\.\d+)?)\s*秒/);
				const dur = durM ? Number(durM[2]) - Number(durM[1]) : undefined;
				out.push(seg(idx, block, dur && dur > 0 ? dur : undefined));
			}
			if (out.length > 0) return out;
		}
	}

	// 3) Markdown 表格
	const tableRows = text.split(/\r?\n/).filter((l) => /^\s*\|.*\|\s*$/.test(l));
	if (tableRows.length >= 2) {
		const cells = (l: string) => l.trim().replace(/^\||\|$/g, "").split("|").map((c) => c.trim());
		const isSep = (l: string) => /-/.test(l) && cells(l).every((c) => /^:?-+:?$/.test(c) || c === "");
		const header = cells(tableRows[0]);
		const findCol = (...kw: string[]) => header.findIndex((h) => kw.some((k) => h.includes(k)));
		const contentCol = findCol("剧本", "内容", "原文", "画面", "提示词", "描述", "scriptContent");
		const durCol = findCol("时长", "时间", "秒", "duration");
		const idxCol = findCol("分镜", "镜头", "序号", "编号", "#");
		const out: ShotSegment[] = [];
		for (const row of tableRows.slice(1)) {
			if (isSep(row)) continue;
			const cs = cells(row);
			if (cs.every((c) => !c)) continue;
			let p = contentCol >= 0 ? cs[contentCol] : "";
			if (!p) p = cs.reduce((a, b) => (b.length > a.length ? b : a), "");
			if (!p) continue;
			const n = out.length + 1;
			const index = (idxCol >= 0 && parseInt(cs[idxCol], 10)) || n;
			const durStr = durCol >= 0 ? cs[durCol] : "";
			const durM = durStr.match(/\d+(?:\.\d+)?/);
			out.push(seg(index, p, durM ? Number(durM[0]) : undefined));
		}
		if (out.length > 0) return out;
	}

	// 4)「分镜N」/编号分块
	const blocks = text.split(/\n(?=\s*(?:分镜|镜头|shot)\s*\d+|^\s*\d+[.、])/i).map((b) => b.trim()).filter(Boolean);
	if (blocks.length > 1) {
		return blocks.map((b, i) => seg(i + 1, b.replace(/^\s*(?:分镜|镜头|shot)?\s*\d+[.、:：]?/i, "").trim()));
	}

	// 5) 整段兜底
	if (text.trim()) return [seg(1, text.trim())];
	return [];
}
