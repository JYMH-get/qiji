/**
 * assetMatch —— 资产匹配（与资产模式 Frame161195 同算法）：扫文本命中角色/群像/场景/生物/物品
 * (名称+别名+造型名，场景不做模糊保底)。资产图优先取「原文点名的造型 > 资产助手当前选中造型 > 基础形象」。
 * 画布「生成图片」节点连接上游文本时自动据此把匹配到的资产图设为参考垫图。
 */
import { useProjectStore } from "@/store/projectStore";
import { useCanvasStore } from "@/store/canvasStore";
import { useLibraryStore } from "@/store/libraryStore";
import { useAssetFormStore } from "@/store/assetFormStore";
import { getPlugin } from "@/nodes/pluginRegistry";
import { withLegend } from "@/lib/shotMaterials";
import { buildNodeLegend, computeMatOrder } from "@/canvas/nodeMaterials";
import { findProjectAssetByImage } from "@/lib/projectAssets";

// ── 高精度匹配器（第86轮）────────────────────────────────────
// 旧匹配 = 纯 text.includes(term)：原文写法与资产名有丝毫格式差异（空格/标点/全半角/大小写）就漏配。
// 新匹配两层：① 归一化后精确子串（剥空格与常见标点、ASCII 小写——格式差异不再挡匹配，命中语义仍是全等）；
// ② 相似度 ≥80% 才采用的滑窗编辑距离兜底（按 80% 阈值：词长 <5 允许编辑数=0 即必须全等——
//    中文名 2~4 字改 1 字就是别人，绝不放宽；5~9 字容 1 处出入，10+ 字容 2 处）。

const NORM_STRIP_RE = /[\s·・‧（）()「」『』【】《》〈〉<>#*"'“”‘’，,。．.!！？?：:；;—－\-_~～/\\|]+/g;
const normForMatch = (s: string) => String(s || "").replace(NORM_STRIP_RE, "").toLowerCase();

/** 带上限的编辑距离判定：dist(a,b) ≤ maxDist ？（行内早停，超限立即 false） */
function editDistanceLE(a: string, b: string, maxDist: number): boolean {
	if (Math.abs(a.length - b.length) > maxDist) return false;
	const n = a.length, m = b.length;
	let prev = new Array<number>(m + 1);
	let cur = new Array<number>(m + 1);
	for (let j = 0; j <= m; j++) prev[j] = j;
	for (let i = 1; i <= n; i++) {
		cur[0] = i;
		let rowMin = cur[0];
		for (let j = 1; j <= m; j++) {
			cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
			if (cur[j] < rowMin) rowMin = cur[j];
		}
		if (rowMin > maxDist) return false; // 整行都超限：后续只会更大
		[prev, cur] = [cur, prev];
	}
	return prev[m] <= maxDist;
}

/** 文本中是否存在与 term 相似度 ≥ minSim 的子串（滑窗；term 需先归一化） */
function fuzzyContains(text: string, term: string, minSim: number): boolean {
	// +1e-9 抵消浮点误差（如 1-0.9=0.0999…会让 10 字词的允许编辑数被 floor 成 0）
	const maxDist = Math.floor(term.length * (1 - minSim) + 1e-9);
	if (maxDist <= 0) return false; // 阈值下不允许任何编辑 → 精确子串已在上层查过
	const scan = text.length > 20000 ? text.slice(0, 20000) : text; // 成本上限（分镜/提示词远小于此）
	for (let w = term.length - maxDist; w <= term.length + maxDist; w++) {
		if (w <= 0 || w > scan.length) continue;
		for (let i = 0; i + w <= scan.length; i++) {
			if (editDistanceLE(scan.slice(i, i + w), term, maxDist)) return true;
		}
	}
	return false;
}

/** 匹配阈值：相似度 ≥80% 才采用（低于它宁可漏配也不误配；第86轮定 90%，用户随即调至 80%） */
export const MATCH_MIN_SIMILARITY = 0.8;

/**
 * 构造针对一段文本的资产词匹配器（文本归一化只做一次，词级结果带缓存）。
 * 资产模式「提取资产」与画布「匹配素材」共用——命中标准完全一致。
 */
export function makeTermMatcher(rawText: string): (term: string) => boolean {
	const text = normForMatch(rawText);
	const cache = new Map<string, boolean>();
	return (rawTerm: string) => {
		const term = normForMatch(rawTerm);
		if (!term) return false;
		const hit = cache.get(term);
		if (hit !== undefined) return hit;
		const ok = text.includes(term) || fuzzyContains(text, term, MATCH_MIN_SIMILARITY);
		cache.set(term, ok);
		return ok;
	};
}

/** 从提示词中剥掉素材图例前缀行（「【素材图例】…」是上一轮提取写入的资产名清单，参与匹配会自我循环） */
export function stripLegendForMatch(s: string): string {
	return String(s || "").replace(/【素材图例】[^\n]*\n?/g, "");
}

/** 从资产名解析匹配候选（含别名）：按 / ／ 、 | ， 分隔，括号内也作别名 */
export function aliasTerms(name: string): string[] {
	const base = String(name || "").trim();
	if (!base) return [];
	const set = new Set<string>([base]);
	const parens = base.match(/[（(]([^（）()]+)[)）]/g) || [];
	const core = base.replace(/[（(][^（）()]*[)）]/g, "/");
	for (const part of core.split(/[/／、|，,]/)) { const t = part.trim(); if (t) set.add(t); }
	for (const p of parens) {
		const inner = p.replace(/[（()）]/g, "").trim();
		for (const part of inner.split(/[/／、|，,]/)) { const t = part.trim(); if (t) set.add(t); }
	}
	return [...set].filter(Boolean);
}

export type MatchKind = "character" | "scene" | "creature" | "prop" | "crowd";
export interface MatchedAsset {
	kind: MatchKind; name: string; image?: string; assetId: string;
	/** 角色绑定的音色（供画布/资产模式把「声音参考」音频一并加入素材并在图例配对） */
	voiceUri?: string; voiceAssetId?: string; voiceName?: string;
}
interface PoolForm { variantId: string | null; name: string; image: string; terms: string[] }
interface PoolItem extends MatchedAsset { terms: string[]; forms: PoolForm[] }

/** 从 projectStore 构建资产池（5 类）：terms 含名称+别名+各造型名；forms=全部有图造型（基础+变体） */
function buildAssetPool(): PoolItem[] {
	const s = useProjectStore.getState();
	const pool: PoolItem[] = [];
	const push = (kind: MatchKind, a: any) => {
		const baseTerms = aliasTerms(a.name);
		const baseSet = new Set(baseTerms);
		const forms: PoolForm[] = [];
		if (a.image) forms.push({ variantId: null, name: a.name, image: a.image, terms: [] });
		for (const v of a.variants ?? []) {
			if (!v.image) continue;
			const terms = aliasTerms(v.name || "").filter((t: string) => !baseSet.has(t));
			forms.push({ variantId: v.id, name: v.name || `${a.name}·${v.label || "造型"}`, image: v.image, terms });
		}
		pool.push({
			kind, name: a.name, image: a.image, assetId: a.id,
			terms: [...new Set([...baseTerms, ...forms.flatMap((f) => f.terms)])], forms,
			voiceUri: a.voiceUri, voiceAssetId: a.voiceAssetId, voiceName: a.voiceName,
		});
	};
	for (const a of s.characters || []) push("character", a);
	for (const a of s.crowds || []) push("crowd", a);
	for (const a of s.scenes || []) push("scene", a);
	for (const a of s.organisms || []) push("creature", a);
	for (const a of s.items || []) push("prop", a);
	return pool;
}

/** 扫文本匹配资产（与资产模式一致）：五类均按名称/别名/造型名命中（场景不做低阈值模糊保底）。
 *  命中标准 = 归一化精确子串 或 相似度 ≥80%（makeTermMatcher）。
 *  资产图优先「原文点名的造型 > 资产助手当前选中造型 > 基础形象 > 首个有图造型」。 */
export function matchAssetsInText(text: string): MatchedAsset[] {
	if (!text.trim()) return [];
	const pool = buildAssetPool();
	const matches = makeTermMatcher(text);
	const selFormMap = useAssetFormStore.getState().selForm;
	const out: MatchedAsset[] = [];
	const seen = new Set<string>();
	const add = (a: PoolItem) => {
		if (seen.has(a.assetId)) return;
		seen.add(a.assetId);
		const hitForm = a.forms.find((f) => f.variantId !== null && f.terms.some((t) => t && matches(t)));
		const sel = selFormMap[a.assetId];
		const selForm = sel !== undefined ? a.forms.find((f) => f.variantId === sel) : undefined;
		const form = hitForm ?? selForm ?? a.forms.find((f) => f.variantId === null) ?? a.forms[0];
		out.push({
			kind: a.kind, name: hitForm ? hitForm.name : a.name, image: form?.image || a.image, assetId: a.assetId,
			voiceUri: a.voiceUri, voiceAssetId: a.voiceAssetId, voiceName: a.voiceName,
		});
	};
	for (const a of pool) { if (a.terms.some((t) => t && matches(t))) add(a); }
	return out;
}

/** 取连入某节点的上游文本（文本/对话/种子类上游的 resultText 或 prompt） */
function upstreamTextOf(nodeId: string): string {
	const cs = useCanvasStore.getState();
	const texts: string[] = [];
	for (const e of Object.values(cs.edges)) {
		if (e.target !== nodeId) continue;
		const up = cs.nodes[e.source];
		if (!up) continue;
		const p = getPlugin(up.type);
		const isText = p?.displayKind === "text" || p?.displayKind === "chat" || p?.nodeKind === "seed";
		if (!isText) continue;
		const t = typeof up.data.resultText === "string" && up.data.resultText.trim()
			? up.data.resultText
			: typeof up.data.params.prompt === "string" ? (up.data.params.prompt as string) : "";
		if (t.trim()) texts.push(t);
	}
	return texts.join("\n\n");
}

// buildNodeLegend（节点素材图例）已抽到 @/canvas/nodeMaterials（与素材增删同步共用），此处直接引用。

/**
 * 对一个「生成图片」节点执行资产匹配：扫 上游文本+节点提示词 → 匹配资产 → 把资产图**追加**进参考垫图(input.images)。
 * **合并而非覆盖**（第86轮修正）：旧实现整组替换 images——自加素材被清掉、顺序重排，提示词里已插入的
 * @ImageN 胶囊全部错位/悬空（上游素材+匹配素材并用时 @/# 引用失效的根因）。现改为：
 * 已有素材原样保留（编号不动），只追加尚未存在的匹配项（按 id/url 去重），并带上资产名（@ 待选框/#导入按名可查）。
 * 返回**新增**素材数。
 * promptOverride：以该文本代替节点当前提示词参与匹配与图例写入（提示词放大弹窗用——草稿尚未保存，
 * 以草稿为准；新提示词同样写回节点，弹窗保存时再落一次同值幂等）。
 */
export function applyAssetMatchToImageNode(nodeId: string, promptOverride?: string): number {
	const cs = useCanvasStore.getState();
	const node = cs.nodes[nodeId];
	if (!node) return 0;
	// 匹配范围 = 上游文本 + 节点自己的提示词（裂变出的图片节点资产名就在提示词里，不只在上游原文）。
	// 节点提示词里已有的「【素材图例】」前缀先剥掉再匹配——否则图例里的资产名会自我循环命中。
	const ownPrompt = promptOverride ?? (typeof node.data.params.prompt === "string" ? (node.data.params.prompt as string) : "");
	const matched = matchAssetsInText([upstreamTextOf(nodeId), stripLegendForMatch(ownPrompt)].filter(Boolean).join("\n\n")).filter((m) => m.image);
	const ps = useProjectStore.getState();
	type ImgRef = { id?: string; url?: string; name?: string; assetId?: string; voiceForAssetId?: string };
	const inp = (node.data.input as Record<string, ImgRef[]> | undefined) || {};
	let existing: ImgRef[] = Array.isArray(inp.images) ? [...inp.images] : [];
	const audios: ImgRef[] = Array.isArray(inp.audios) ? [...inp.audios] : [];
	const hasIn = (arr: ImgRef[], id?: string, url?: string) => arr.some((m) => (!!id && m.id === id) || (!!url && m.url === url));
	let added = 0;
	// ── 绑定资产识别（第114轮补，用户报「绑定后匹配不加前缀」的根因）：素材不是靠名字匹配进来的
	// （上游连线 / 拖入 / 粘贴原图——提示词里未必点名该资产），按名匹配自然不认识它。这里反查素材
	// 是否是项目资产的图（绑定/出图写回均算）：命中则以资产身份进图例（自加素材就地补 name/assetId，
	// 上游素材由 buildNodeLegend 内同样反查），并把该资产绑定的音色作「声音参考」一并加入（与按名匹配同语义）。
	const boundHits: ReturnType<typeof findProjectAssetByImage>[] = [];
	for (const e of Object.values(cs.edges)) {
		if (e.target !== nodeId) continue;
		const up = cs.nodes[e.source];
		const lib = up?.data.resultAssetId ? useLibraryStore.getState().assets[up.data.resultAssetId] : null;
		if (lib?.uri && lib.kind === "image") boundHits.push(findProjectAssetByImage(lib.uri, lib.serverAssetId || lib.id));
	}
	existing = existing.map((ref) => {
		const hit = findProjectAssetByImage(ref.url, ref.id);
		if (!hit) return ref;
		boundHits.push(hit);
		if (ref.name && ref.assetId) return ref;
		return { ...ref, name: ref.name || hit.name, assetId: ref.assetId || hit.assetId };
	});
	for (const hit of boundHits) {
		if (!hit?.voiceUri || hasIn(audios, hit.voiceAssetId, hit.voiceUri)) continue;
		const vblob = ps.blobByUri(hit.voiceUri);
		audios.push({
			id: vblob?.id || hit.voiceAssetId,
			url: vblob?.url || hit.voiceUri,
			name: hit.voiceName || `${hit.name}的声音`,
			assetId: hit.voiceAssetId,
			voiceForAssetId: hit.assetId,
		});
		added++;
	}
	for (const m of matched) {
		const blob = m.image ? ps.blobByUri(m.image) : undefined;
		// assetId=资产实体 id（角色本体），供音频「声音参考」按此配对；id=serverAssetId（图生图取字节）
		const ref: ImgRef = blob
			? { id: blob.id, url: blob.url, name: m.name, assetId: m.assetId }
			: { url: m.image as string, name: m.name, assetId: m.assetId };
		if (!hasIn(existing, ref.id, ref.url)) { existing.push(ref); added++; }
		// 角色绑定了音色 → 把「声音参考」音频一并加入 input.audios，标记归属角色供图例配对「@ImageN的声音参考@AudioM」
		if (m.voiceUri && !hasIn(audios, m.voiceAssetId, m.voiceUri)) {
			const vblob = ps.blobByUri(m.voiceUri);
			audios.push({
				id: vblob?.id || m.voiceAssetId,
				url: vblob?.url || m.voiceUri,
				name: m.voiceName || `${m.name}的声音`,
				assetId: m.voiceAssetId,
				voiceForAssetId: m.assetId,
			});
			added++;
		}
	}
	// 写入「素材图例」前缀（与资产模式同格式 @xxx是xxx；含「@ImageN的声音参考@AudioM」）：
	// 按更新后的素材编号重建、幂等刷新（不堆叠）。同步落 matOrder 快照（锁定加入顺序——
	// 此后再连线的上游素材只会排在本次匹配素材之后，已写入的 @ 引用不错位）。
	const newInput: Record<string, unknown> = { ...node.data.input, images: existing };
	if (audios.length) newInput.audios = audios;
	const legend = buildNodeLegend(nodeId, newInput as Record<string, ImgRef[]>);
	const newPrompt = withLegend(ownPrompt, legend);
	if (!added && newPrompt === ownPrompt) return 0; // 无新增且图例无变化
	const matOrder = computeMatOrder(nodeId, newInput as Record<string, ImgRef[]>);
	useCanvasStore.setState({
		nodes: { ...cs.nodes, [nodeId]: { ...node, data: { ...node.data, input: newInput, matOrder, params: { ...node.data.params, prompt: newPrompt } } } },
	});
	return added;
}

/**
 * 提示词放大弹窗的「匹配资产」宿主实现（画布图片/视频节点共用，OperationPanel/VideoOperationPanel 传给弹窗）：
 * 以弹窗草稿为提示词执行 applyAssetMatchToImageNode（同一实现，含音色声音参考+图例），
 * 返回更新后的提示词供弹窗刷新草稿；无匹配/无变化返回 null（草稿不动）。
 */
export function matchNodeDraftAssets(nodeId: string, draft: string): { prompt: string; added: number } | null {
	const before = useCanvasStore.getState().nodes[nodeId];
	if (!before) return null;
	const added = applyAssetMatchToImageNode(nodeId, draft);
	const after = useCanvasStore.getState().nodes[nodeId];
	if (!after || after === before) return null; // 未写入（无新增且图例无变化）
	const p = after.data.params.prompt;
	return { prompt: typeof p === "string" ? p : draft, added };
}
