/**
 * episodeSplit —— 剧集分集的 4 种**确定性切分**（不调大模型），与资产模式（Frame1693）一致。
 *
 * 资产模式的剧集拆分提供 4 个快速选项（纯本地）：
 *   按第N集/章/回 · 按双换行(空行) · n-n(逐编号) · n-1(逐主编号)。
 * 画布「剧集分集」节点是纯脚本节点，复用这套算法。返回 `{title, scriptText}[]`。
 */

export const EPISODE_SPLIT_MODES = ["按第N集", "按双换行", "n-n", "n-1"] as const;
export type EpisodeSplitMode = (typeof EPISODE_SPLIT_MODES)[number];

/** 按空行（连续两次及以上换行）切块 */
function splitByBlankLines(scriptText: string): string[] {
	return (scriptText || "").split(/\n\s*\n+/).map((b) => b.trim()).filter(Boolean);
}

/** 双换行：每个空行块 = 一集（扁平编号 第N集） */
function splitEpisodesByBlankLine(scriptText: string): Array<{ title: string; scriptText: string }> {
	return splitByBlankLines(scriptText).map((b, i) => ({ title: `第${i + 1}集`, scriptText: b }));
}

/** 在剧本里找「主-副」编号标记（行首形如 1-1 / 2-3 / 1.2，或带「场」前缀的 场1-1 / 场2-3）。
 *  容差「场」前缀：剧本若以「场n-n」格式分场，n-n/n-1 也能拆。 */
function findShotMarkers(scriptText: string): Array<{ major: number; minor: number; index: number; label: string }> {
	const lines = (scriptText || "").split(/\r?\n/);
	const out: Array<{ major: number; minor: number; index: number; label: string }> = [];
	let offset = 0;
	for (const line of lines) {
		const m = line.match(/^(\s*)(?:场\s*)?(\d+)\s*[-－—.·、:：]\s*(\d+)/);
		if (m) {
			const major = Number(m[2]), minor = Number(m[3]);
			out.push({ major, minor, index: offset + (m[1] ? m[1].length : 0), label: `${major}-${minor}` });
		}
		offset += line.length + 1; // +1 为换行符
	}
	return out;
}

/** 按边界索引切片；首个边界前的内容（若有）作「0-引言」 */
function sliceByBoundaries(text: string, boundaries: Array<{ index: number; label: string }>): Array<{ title: string; scriptText: string }> {
	const eps: Array<{ title: string; scriptText: string }> = [];
	const firstIdx = boundaries.length ? boundaries[0].index : text.length;
	const intro = text.slice(0, firstIdx).trim();
	if (intro) eps.push({ title: "0-引言", scriptText: intro });
	for (let i = 0; i < boundaries.length; i++) {
		const start = boundaries[i].index;
		const end = i + 1 < boundaries.length ? boundaries[i + 1].index : text.length;
		const seg = text.slice(start, end).trim();
		if (seg) eps.push({ title: boundaries[i].label, scriptText: seg });
	}
	return eps;
}

/** n-n（逢数拆分）：每遇到一个编号标记就拆 → 1-1,1-2,1-3,2-1,2-2…（最细） */
function splitEpisodesNN(scriptText: string): Array<{ title: string; scriptText: string }> {
	const markers = findShotMarkers(scriptText);
	if (markers.length === 0) return [];
	return sliceByBoundaries(scriptText, markers.map((m) => ({ index: m.index, label: m.label })));
}

/** n-1（逢1拆分）：只在主编号变化处拆 → 1-1,2-1,3-1… */
function splitEpisodesN1(scriptText: string): Array<{ title: string; scriptText: string }> {
	const markers = findShotMarkers(scriptText);
	if (markers.length === 0) return [];
	const boundaries: Array<{ index: number; label: string }> = [];
	let prevMajor: number | null = null;
	for (const m of markers) {
		if (prevMajor === null || m.major !== prevMajor) { boundaries.push({ index: m.index, label: m.label }); prevMajor = m.major; }
	}
	return sliceByBoundaries(scriptText, boundaries);
}

/** 按「第N集/章/回/话/幕」标题切分（N 支持阿拉伯与中文数字） */
function splitEpisodesByMarkers(scriptText: string): Array<{ title: string; scriptText: string }> {
	const text = scriptText || "";
	const re = /第\s*[0-9一二三四五六七八九十百千零〇两]+\s*[集章回话幕]/g;
	const marks: Array<{ index: number; title: string }> = [];
	let m: RegExpExecArray | null;
	while ((m = re.exec(text)) !== null) {
		const lineEnd = text.indexOf("\n", m.index);
		const title = text.slice(m.index, lineEnd < 0 ? text.length : lineEnd).trim();
		marks.push({ index: m.index, title });
	}
	if (marks.length === 0) return [];
	const out: Array<{ title: string; scriptText: string }> = [];
	for (let i = 0; i < marks.length; i++) {
		const start = marks[i].index;
		const end = i + 1 < marks.length ? marks[i + 1].index : text.length;
		const seg = text.slice(start, end).trim();
		if (seg) out.push({ title: marks[i].title, scriptText: seg });
	}
	return out;
}

/** 按所选模式确定性切分剧集。无标记的 n-n/n-1 返回空；按第N集无标记则整段作 1 集。 */
export function splitEpisodes(text: string, mode: string): Array<{ title: string; scriptText: string }> {
	switch (mode) {
		case "按双换行":
			return splitEpisodesByBlankLine(text);
		case "n-n":
			return splitEpisodesNN(text);
		case "n-1":
			return splitEpisodesN1(text);
		case "按第N集":
		default: {
			const r = splitEpisodesByMarkers(text);
			if (r.length) return r;
			return text.trim() ? [{ title: "第1集", scriptText: text.trim() }] : [];
		}
	}
}
