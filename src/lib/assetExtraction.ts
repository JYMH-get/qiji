/**
 * assetExtraction —— 资产/分集解析（纯函数，无 store/React 依赖）。
 *
 * `parseAssetExtraction` 是**资产模式与画布共用的权威解析器**（原在 Frame1693，抽到此处）：
 * 解析 `script.analyze`(asset.extract.v1) 输出，按 C/A/G/M/S/P 编号前缀分流到角色/场景/生物/道具/群像，
 * 变体折叠进父资产，含视觉圣经与截断兜底。画布「资产拆分」节点与表格模式都用它，保证提示词与格式化一致。
 */

/** 从可能夹带散文的 LLM 文本里抠出第一个完整 JSON 对象（花括号配平，容忍 ```json``` 与转义） */
export function extractJsonObject(text: string): any | null {
	const t = (text || "").trim();
	const fence = t.match(/```(?:json)?\s*([\s\S]*?)```/i);
	const candidates: string[] = [];
	if (fence) candidates.push(fence[1].trim());
	const start = t.indexOf("{");
	if (start >= 0) {
		let depth = 0, inStr = false, esc = false;
		for (let i = start; i < t.length; i++) {
			const ch = t[i];
			if (inStr) {
				if (esc) esc = false;
				else if (ch === "\\") esc = true;
				else if (ch === '"') inStr = false;
			} else if (ch === '"') inStr = true;
			else if (ch === "{") depth++;
			else if (ch === "}") { depth--; if (depth === 0) { candidates.push(t.slice(start, i + 1)); break; } }
		}
	}
	for (const c of candidates) {
		try { return JSON.parse(c); } catch { /* 试下一个候选 */ }
	}
	return null;
}

// 截断兜底：整段 JSON 因超长被截断时，从指定数组里逐个抠出已闭合的元素对象，丢弃末尾不完整的那个。
function recoverArrayObjects(text: string, arrayKey: string): any[] {
	const keyIdx = text.indexOf(`"${arrayKey}"`);
	if (keyIdx < 0) return [];
	const bracket = text.indexOf("[", keyIdx);
	if (bracket < 0) return [];
	const objs: any[] = [];
	let i = bracket + 1;
	while (i < text.length) {
		const ch = text[i];
		if (ch === "]") break;
		if (ch !== "{") { i++; continue; }
		let depth = 0, inStr = false, esc = false, j = i;
		for (; j < text.length; j++) {
			const c = text[j];
			if (inStr) { if (esc) esc = false; else if (c === "\\") esc = true; else if (c === '"') inStr = false; }
			else if (c === '"') inStr = true;
			else if (c === "{") depth++;
			else if (c === "}") { depth--; if (depth === 0) break; }
		}
		if (depth !== 0 || j >= text.length) break;
		try { objs.push(JSON.parse(text.slice(i, j + 1))); } catch { /* 单个坏对象跳过 */ }
		i = j + 1;
	}
	return objs;
}

// 抠出某 key 后第一个完整 JSON 对象（即便整段被截断也能取到靠前的 visualBible）
function recoverObjectAfterKey(text: string, key: string): any | null {
	const keyIdx = text.indexOf(`"${key}"`);
	if (keyIdx < 0) return null;
	const start = text.indexOf("{", keyIdx);
	if (start < 0) return null;
	let depth = 0, inStr = false, esc = false;
	for (let i = start; i < text.length; i++) {
		const c = text[i];
		if (inStr) { if (esc) esc = false; else if (c === "\\") esc = true; else if (c === '"') inStr = false; }
		else if (c === '"') inStr = true;
		else if (c === "{") depth++;
		else if (c === "}") { depth--; if (depth === 0) { try { return JSON.parse(text.slice(start, i + 1)); } catch { return null; } } }
	}
	return null;
}

export type VisualBible = { style: string; colorSystem: string; negativeGlobal: string };
const asStr = (v: any): string => (Array.isArray(v) ? v.filter(Boolean).join("、") : v == null ? "" : String(v));

function extractVisualBible(text: string, root: any | null): VisualBible {
	const vb = (root && root.visualBible) || recoverObjectAfterKey(text, "visualBible") || {};
	return {
		style: asStr(vb.style ?? vb.视觉风格 ?? vb.styleAnchors),
		colorSystem: asStr(vb.colorSystem ?? vb.colorTone ?? vb.colorPalette ?? vb.全局色调),
		negativeGlobal: asStr(vb.negativeGlobal ?? vb.negativeBaseline ?? vb.negative ?? vb.全局禁用词 ?? vb.全局禁用),
	};
}

export type ParsedAsset = {
	id: string; name: string; features: string; philosophy: string; prompt: string;
	image?: string; variants: any[]; code?: string; inheritsFrom?: string; variantPayload?: any;
};

export interface AssetExtractionResult {
	characters: ParsedAsset[]; scenes: ParsedAsset[]; items: ParsedAsset[]; organisms: ParsedAsset[]; crowds: ParsedAsset[];
	visualBible: VisualBible;
	truncated: boolean;
	lastLabel: string;
}

/**
 * 解析资产提取 LLM 输出（asset.extract.v1）：按 C/A/G/M/S/P 编号前缀分流，变体折叠进父资产。
 * 兼容扁平 assets[] 与嵌套 characters[]/scenes[]/creatures[]/props[]。**资产模式与画布共用**。
 */
export function parseAssetExtraction(text: string): AssetExtractionResult {
	const root = extractJsonObject(text);
	const visualBible = extractVisualBible(text, root);
	const empty: AssetExtractionResult = {
		characters: [], scenes: [], items: [], organisms: [], crowds: [], visualBible, truncated: false, lastLabel: "",
	};

	const flat: any[] = [];
	let truncated = false;
	const expandInto = (arr: any, cat: string) =>
		Array.isArray(arr) &&
		arr.forEach((a) => {
			flat.push({ ...a, category: a.category || cat });
			(a.variants || []).forEach((v: any) => flat.push({ ...v, category: a.category || cat, inheritsFrom: v.inheritsFrom || v.inherits_from || a.code || a.id }));
		});

	if (root) {
		if (Array.isArray(root.assets)) flat.push(...root.assets);
		else { expandInto(root.characters, "character"); expandInto(root.scenes, "scene"); expandInto(root.creatures, "creature"); expandInto(root.props, "prop"); }
	} else {
		const flatAssets = recoverArrayObjects(text, "assets");
		if (flatAssets.length) flat.push(...flatAssets);
		else {
			expandInto(recoverArrayObjects(text, "characters"), "character");
			expandInto(recoverArrayObjects(text, "scenes"), "scene");
			expandInto(recoverArrayObjects(text, "creatures"), "creature");
			expandInto(recoverArrayObjects(text, "props"), "prop");
			expandInto(recoverArrayObjects(text, "crowds"), "crowd");
		}
		if (flat.length) truncated = true;
	}
	if (flat.length === 0) return empty;

	const ts = Date.now();
	let n = 0;
	const codeOf = (a: any) => String(a.id || a.code || "").trim();
	const parentCode = (code: string) => (code.match(/^([A-Za-z]+\d+)/) || [])[1] || code;
	const isVariant = (a: any) => {
		const c = codeOf(a);
		return !!(a.inheritsFrom || a.inherits_from) || /^[A-Za-z]+\d+[A-Za-z]+$/.test(c) || /variant/i.test(String(a.type || ""));
	};
	const buckets = { characters: [] as ParsedAsset[], scenes: [] as ParsedAsset[], items: [] as ParsedAsset[], organisms: [] as ParsedAsset[], crowds: [] as ParsedAsset[] };
	const bucketOf = (a: any): keyof typeof buckets => {
		const c = codeOf(a).toUpperCase();
		const head = c[0];
		if (head === "S") return "scenes";
		if (head === "M") return "organisms";
		if (head === "P") return "items";
		if (head === "G") return "crowds";
		if (head === "C" || head === "A") return "characters";
		const cat = String(a.category || a.type || "").toLowerCase();
		if (cat.includes("scene") || cat.includes("environment")) return "scenes";
		if (cat.includes("creature") || cat.includes("monster") || cat.includes("beast")) return "organisms";
		if (cat.includes("prop") || cat.includes("item") || cat.includes("weapon")) return "items";
		if (cat.includes("group") || cat.includes("crowd") || cat.includes("ensemble")) return "crowds";
		return "characters";
	};
	const byCode: Record<string, ParsedAsset> = {};

	for (const a of flat) {
		if (isVariant(a)) continue;
		const code = codeOf(a);
		const asset: ParsedAsset = {
			id: `${code || "asset"}-${ts}-${++n}`,
			name: String(a.name || a.title || code || "未命名资产").trim(),
			features: String(a.reason || a.status || "").trim(),
			philosophy: "",
			prompt: String(a.prompt || a.imagePrompt || a.image_prompt || "").trim(),
			image: undefined,
			variants: [],
			code: code || undefined,
		};
		buckets[bucketOf(a)].push(asset);
		if (code) byCode[parentCode(code).toUpperCase()] = asset;
	}
	for (const a of flat) {
		if (!isVariant(a)) continue;
		const code = codeOf(a);
		const pcode = parentCode(code).toUpperCase();
		const variant = {
			id: `${code || "var"}-${ts}-${++n}`,
			code: code || undefined, // 变体自身编号（C01A），供画布裂变按编号回查/注册
			label: String(a.status || a.label || "变体").trim(),
			name: String(a.name || a.title || "").trim(),
			description: String(a.reason || "").trim(),
			prompt: String(a.prompt || a.imagePrompt || a.image_prompt || "").trim(),
			image: undefined,
		};
		const parent = byCode[pcode];
		if (parent) parent.variants.push(variant);
		else buckets[bucketOf(a)].push({ id: variant.id, name: variant.name || code, features: variant.description, philosophy: "", prompt: variant.prompt, image: undefined, variants: [], code: code || undefined, inheritsFrom: pcode, variantPayload: variant });
	}
	const lastRaw = flat[flat.length - 1];
	const lastLabel = truncated
		? [String(lastRaw?.id || lastRaw?.code || "").trim(), String(lastRaw?.name || lastRaw?.title || "").trim()].filter(Boolean).join(" ")
		: "";
	return { ...buckets, visualBible, truncated, lastLabel };
}

/** 资产大类（与资产工作台 AssetCat 一致），供裂变节点按类写 purpose/编号前缀 */
export type SpawnAssetCat = "characters" | "crowds" | "scenes" | "organisms" | "items";

export interface SpawnAsset {
	code?: string;
	name: string;
	/** 出图提示词（整段出图模板，来自 parseAssetExtraction 的 prompt 字段） */
	prompt: string;
	/** 所属大类（变体随父类）——裂变图片节点按此写 purpose/idPrefix，与资产模式同路由同编号 */
	cat: SpawnAssetCat;
	/** 变体项：主体资产的编号/名称（裂变时据此加「主体→变体」连线，垫图参考） */
	baseCode?: string;
	baseName?: string;
}

/**
 * 资产提取结果 → 待出图的资产列表（含变体），**用与资产模式相同的 parseAssetExtraction**。
 * 画布「资产拆分」裂变图片节点用；只返回带出图提示词的资产。
 */
export function parseAssetsForSpawn(text: string): SpawnAsset[] {
	const ex = parseAssetExtraction(text);
	const out: SpawnAsset[] = [];
	const push = (a: ParsedAsset, cat: SpawnAssetCat) => {
		// 顶层项本身也可能是"孤儿变体"（解析时找不到主体，inheritsFrom 记录了主体编号）
		if (a.prompt?.trim()) out.push({ code: a.code, name: a.name, prompt: a.prompt, cat, baseCode: a.inheritsFrom });
		for (const v of a.variants ?? []) {
			const vp = String(v.prompt || "").trim();
			if (vp) {
				out.push({
					code: v.code,
					name: `${a.name} · ${String(v.label || v.name || "变体").trim()}`,
					prompt: vp,
					cat,
					baseCode: a.code,
					baseName: a.name,
				});
			}
		}
	};
	const cats: [ParsedAsset[], SpawnAssetCat][] = [
		[ex.characters, "characters"], [ex.scenes, "scenes"], [ex.items, "items"], [ex.organisms, "organisms"], [ex.crowds, "crowds"],
	];
	for (const [bucket, cat] of cats) {
		for (const a of bucket) push(a, cat);
	}
	return out;
}

export interface SpawnEpisode {
	index: number;
	title: string;
	content: string;
}

/**
 * 分集结果 → 每集标题 + 内容（用于「剧集分集」裂变文本节点）。
 * 优先 JSON episodes[]（{index,title,summary}）；否则按「第N集/章/回」标记切分；再否则按空行切块。
 */
export function extractEpisodes(text: string): SpawnEpisode[] {
	const root = extractJsonObject(text);
	const eps = root?.episodes ?? root?.scenes ?? root?.parts;
	if (Array.isArray(eps) && eps.length) {
		return eps
			.map((e: any, i: number) => {
				const index = Number(e?.index) || i + 1;
				const title = String(e?.title || e?.name || `第${index}集`).trim();
				const content = String(e?.summary || e?.content || e?.plot || e?.body || title).trim();
				return { index, title, content };
			})
			.filter((e) => e.content);
	}

	const markRe = /第\s*[0-9一二三四五六七八九十百零]+\s*[集章回话]/g;
	const marks = [...text.matchAll(markRe)];
	if (marks.length > 1) {
		const out: SpawnEpisode[] = [];
		for (let i = 0; i < marks.length; i++) {
			const start = marks[i].index ?? 0;
			const end = i + 1 < marks.length ? (marks[i + 1].index ?? text.length) : text.length;
			const block = text.slice(start, end).trim();
			if (!block) continue;
			const title = (block.split(/\r?\n/)[0] || `第${out.length + 1}集`).trim().slice(0, 24);
			out.push({ index: out.length + 1, title, content: block });
		}
		if (out.length) return out;
	}

	const blocks = text.split(/\n\s*\n+/).map((b) => b.trim()).filter(Boolean);
	if (blocks.length > 1) {
		return blocks.map((b, i) => ({ index: i + 1, title: `第${i + 1}集`, content: b }));
	}
	if (text.trim()) return [{ index: 1, title: "第1集", content: text.trim() }];
	return [];
}
