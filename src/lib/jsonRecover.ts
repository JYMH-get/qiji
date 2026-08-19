/**
 * jsonRecover —— 从（可能尚未闭合的）JSON 数组里抢救出**已完整闭合**的元素对象。
 * 用于流式增量解析：模型边输出边解析，已生成的数组元素先显示，末尾不完整的那个丢弃。
 */
export function recoverArrayElements(text: string): any[] {
	const t = text || "";
	const bracket = t.indexOf("[");
	if (bracket < 0) return [];
	const objs: any[] = [];
	let i = bracket + 1;
	while (i < t.length) {
		const ch = t[i];
		if (ch === "]") break; // 数组正常闭合
		if (ch !== "{") { i++; continue; } // 跳过元素间逗号/空白
		let depth = 0, inStr = false, esc = false, j = i;
		for (; j < t.length; j++) {
			const c = t[j];
			if (inStr) { if (esc) esc = false; else if (c === "\\") esc = true; else if (c === '"') inStr = false; }
			else if (c === '"') inStr = true;
			else if (c === "{") depth++;
			else if (c === "}") { depth--; if (depth === 0) break; }
		}
		if (depth !== 0 || j >= t.length) break; // 末尾对象不完整 → 抢救到此为止
		try { objs.push(JSON.parse(t.slice(i, j + 1))); } catch { /* 单个坏对象跳过 */ }
		i = j + 1;
	}
	return objs;
}
