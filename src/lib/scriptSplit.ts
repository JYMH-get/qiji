/**
 * scriptSplit —— 画布「原文节点拆分」的纯逻辑：把一段原文按行拆成多段（每段=一个新原文节点）。
 * UI（ScriptSplitModal）与裂变（canvasSpawn.buildScriptSplitRows）共用，便于单测。
 *  - splitLines：按行切、丢空行（空行不算分格，与资产模式原文分段一致）。
 *  - segmentsFromBoundaries：按「拆分点」把行分组成多段文本（组内按 \n 拼回）。
 *  - nextShotNumber：扫现有「分镜N原文」标题取最大号 + 1，新节点续号不撞车。
 */

/** 「分镜N原文」标题（与 canvasSpawn.SHOT_SCRIPT_TITLE_RE 同义，独立声明避免循环依赖） */
const SHOT_TITLE_RE = /^分镜(\d+)原文$/;

/** 按行切分原文：保留非空行原文（去掉纯空白行——空行不是分格）。 */
export function splitLines(text: string): string[] {
	return String(text || "")
		.split(/\r?\n/)
		.filter((l) => l.trim() !== "");
}

/**
 * 按「拆分点」把行分组成多段。boundaries=行下标集合，含 i 表示「在第 i 行之前断开」（i∈[1,lines.length-1]）。
 * 返回每段的文本（段内行以 \n 拼回）。无拆分点=整体一段。
 */
export function segmentsFromBoundaries(lines: string[], boundaries: Iterable<number>): string[] {
	if (!lines.length) return [];
	const cut = new Set<number>();
	for (const b of boundaries) if (b >= 1 && b < lines.length) cut.add(b);
	const segs: string[] = [];
	let cur: string[] = [];
	for (let i = 0; i < lines.length; i++) {
		if (i > 0 && cut.has(i)) {
			segs.push(cur.join("\n"));
			cur = [];
		}
		cur.push(lines[i]);
	}
	if (cur.length) segs.push(cur.join("\n"));
	return segs;
}

/** 现有标题中「分镜N原文」的最大号 + 1（无则从 1 起）。 */
export function nextShotNumber(titles: Iterable<string>): number {
	let max = 0;
	for (const t of titles) {
		const m = SHOT_TITLE_RE.exec(String(t || "").trim());
		if (m) max = Math.max(max, Number(m[1]));
	}
	return max + 1;
}

/**
 * 父节点的「分镜标识」：从「分镜X原文」取 X（X 可含「-」，如 1 或 1-2——支持嵌套拆分）。
 * 非「分镜…原文」标题 → 回退为 fallbackNum 的字符串（给一个新的顶层分镜号作基）。
 */
export function parentShotId(parentTitle: string, fallbackNum: number): string {
	const m = /^分镜(.+)原文$/.exec(String(parentTitle || "").trim());
	return m ? m[1] : String(fallbackNum);
}

/** 现有标题里「分镜{shotId}-N原文」的最大子序号 + 1（无则 1）——拆分子号续号，重复拆同一节点不撞车。 */
export function nextSubIndex(titles: Iterable<string>, shotId: string): number {
	const esc = shotId.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
	const re = new RegExp("^分镜" + esc + "-(\\d+)原文$");
	let max = 0;
	for (const t of titles) {
		const m = re.exec(String(t || "").trim());
		if (m) max = Math.max(max, Number(m[1]));
	}
	return max + 1;
}

/**
 * 重组（拆分的逆）合并后节点的标题 = **各选中节点分镜号相加**（用户定）：
 *  - 全部是「分镜{id}原文」→ 各 id 以「、」相连，如 分镜1-2原文 + 分镜2-1原文 → 「分镜1-2、2-1原文」；
 *  - 有非「分镜…原文」标题（无分镜号）→ 退回新的「分镜{下一个顶层号}原文」。
 */
export function mergedTitle(selectedTitles: string[], allTitles: Iterable<string>): string {
	const ids = selectedTitles
		.map((t) => /^分镜(.+)原文$/.exec(String(t || "").trim())?.[1])
		.filter((x): x is string => !!x);
	if (ids.length >= 2 && ids.length === selectedTitles.length) return `分镜${ids.join("、")}原文`;
	return `分镜${nextShotNumber(allTitles)}原文`;
}
