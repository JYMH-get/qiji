/**
 * nodeMaterials —— 画布图片/视频节点素材区的唯一枚举与增删（写入 node.data.input / node.data.matOrder）。
 *
 * 节点素材 = 上游连线素材（只读，删除=断开连线） + 自行添加素材（node.data.input.{images,videos,audios}）。
 * **顺序 = 加入顺序**（node.data.matOrder，素材只往后加、不往前插）：先匹配后连线，连线素材排在已匹配
 * 素材之后，提示词里已写入的 @ImageN 引用不错位；未记录进 matOrder 的素材按旧序（上游前、自加后）
 * 补在末尾（旧项目行为不变）。素材区显示 / 图例 / @ 待选框 / 提交收集（pluginRegistry.collectMedia）/
 * 删除重编号 全部经 listNodeMaterials 单点枚举，编号必然一致。
 * 媒体文件先传 OSS（uploadMediaToCanvasAsset）拿 {id, 公网url}，请求用公网 url、显示用本地副本。
 */
import { useCanvasStore } from "@/store/canvasStore";
import { useProjectStore } from "@/store/projectStore";
import { useLibraryStore } from "@/store/libraryStore";
import { TAG_KIND, buildLegend, applyLegend, LEGEND_START } from "@/lib/shotMaterials";
import { findProjectAssetByImage } from "@/lib/projectAssets";
import type { ShotMaterial } from "@/services/projectFile";

// 兼容旧引用/单测：删素材后修正正文内联 @ 引用的纯函数已抽到 shotMaterials
export { renumberBodyRefs as renumberPromptAfterRemoval } from "@/lib/shotMaterials";
import { useUploadStore, uploadKeys } from "@/store/uploadStore";
import { uploadMediaToCanvasAsset, uploadKindFromFile } from "./nodeUpload";
import { getPlugin } from "@/nodes/pluginRegistry";

/**
 * 探测连入本节点的上游**文本**源（供「上游文本胶囊」明示：有则在提示词框显示胶囊）。
 * ⚠ 判定规则须与 pluginRegistry.collectUpstreamTextForNode 保持一致（文本/对话/种子上游 + 取 resultText→prompt）。
 */
export function upstreamTextSources(nodeId: string): { id: string; name: string; text: string }[] {
	const cs = useCanvasStore.getState();
	const out: { id: string; name: string; text: string }[] = [];
	for (const e of Object.values(cs.edges)) {
		if (e.target !== nodeId) continue;
		const up = cs.nodes[e.source];
		if (!up) continue;
		const p = getPlugin(up.type);
		const isTextSrc = p?.displayKind === "text" || p?.displayKind === "chat" || p?.nodeKind === "seed";
		if (!isTextSrc) continue;
		const t = typeof up.data.resultText === "string" && up.data.resultText.trim()
			? up.data.resultText
			: typeof up.data.params.prompt === "string" ? (up.data.params.prompt as string) : "";
		if (!t.trim()) continue;
		out.push({ id: up.id, name: String(up.data.title || p?.label || "上游文本"), text: t });
	}
	return out;
}

export type MatGroup = "images" | "videos" | "audios";
export type MatMedia = "image" | "video" | "audio";
const GROUP: Record<MatMedia, MatGroup> = { image: "images", video: "videos", audio: "audios" };

type LegendRef = { id?: string; url?: string; name?: string; assetId?: string; voiceForAssetId?: string };

/** 素材区一条素材（单点枚举结果）：n/tag 为同媒体分组内 1-based 编号，与图例/提交数组顺序恒一致 */
export interface NodeMatEntry {
	/** matOrder 键：上游=`e:<edgeId>`，自加=`s:<blobId|url>` */
	key: string;
	media: MatMedia;
	/** 同媒体分组内 1-based 编号 */
	n: number;
	/** `@ImageN` / `@VideoN` / `@AudioN` */
	tag: string;
	/** 展示/图例/请求共用名。上游素材＝绑定资产名 > 节点标题 > 上传原文件名 > 节点类型名（绝不直接用 gen_output 时间戳文件名） */
	name: string;
	/** 显示 uri（本地副本优先，CSP 安全） */
	uri: string;
	/** 请求 uri（公网 url 或待 ensurePublicUrl 解析的本地 uri） */
	url: string;
	/** 服务端资产 id（图生图按 id 取字节） */
	id?: string;
	/** 反查/匹配到的项目资产 id（音色「声音参考」按此配对） */
	assetId?: string;
	voiceForAssetId?: string;
	/** 上游连线素材：来源边 id（删除=断开该连线） */
	edgeId?: string;
	/** 自加素材：input 内位置（删除按此 splice） */
	self?: { group: MatGroup; idx: number };
}

/**
 * 单点枚举某节点的全部素材，**按加入顺序**（node.data.matOrder）排序并编号。
 * 未记录进 matOrder 的素材（旧项目 / 连线后上游刚出图 / 本次将写入的新素材）按旧序
 * （上游连线在前、自加 input 在后）补在已记录素材之后——即「素材只往后加」。
 * inputOverride：以将要写入的 input 预演枚举（匹配资产未落库前按新素材编号）。
 */
export function listNodeMaterials(nodeId: string, inputOverride?: Record<string, LegendRef[]>): NodeMatEntry[] {
	const cs = useCanvasStore.getState();
	const node = cs.nodes[nodeId];
	if (!node) return [];
	const assetsMap = useLibraryStore.getState().assets;
	const blobs = useProjectStore.getState().assetBlobs;
	type Raw = Omit<NodeMatEntry, "n" | "tag">;
	const raw: Raw[] = [];
	// (1) 上游连线素材（edge 序）。命名：图已「绑定到资产」/由出图写回 → 资产名（获得资产身份的唯一途径，
	// 供音色声音参考配对）；否则 节点标题（如「分镜3故事板」）> 上传节点的原文件名 > 节点类型名——
	// 生成产物的机器文件名（image.gen_output_<时间戳>）不进图例/前缀。
	// 双快原则·与 ResultView/LibTile 同尺（第146轮）：显示按 id 现查三元映射的活本地副本、请求按 id
	// 现查 OSS 公网 url，库资产 uri 快照只作兜底——快照失效（死 blob:/旧桶）即「垫图黑块/无法播放」根因。
	for (const e of Object.values(cs.edges)) {
		if (e.target !== nodeId) continue;
		const up = cs.nodes[e.source];
		const a = up?.data.resultAssetId ? assetsMap[up.data.resultAssetId] : null;
		if (!a?.uri) continue;
		if (a.kind !== "image" && a.kind !== "video" && a.kind !== "audio") continue;
		const p = getPlugin(up!.type);
		const sid = a.serverAssetId || a.id;
		const bound = a.kind === "image" ? findProjectAssetByImage(a.uri, sid) : null;
		const name = bound?.name
			|| String(up!.data.title || "").trim()
			|| (p?.nodeKind === "upload" ? String(a.name || "").trim() : "")
			|| p?.label
			|| a.name || "";
		raw.push({
			key: `e:${e.id}`, media: a.kind, name,
			uri: (sid && blobs[sid]?.localUri) || a.uri,
			url: (sid && blobs[sid]?.url) || a.uri,
			id: a.serverAssetId || undefined, assetId: bound?.assetId, edgeId: e.id,
		});
	}
	// (2) 自加素材 node.data.input（组内序）
	const input = (inputOverride ?? (node.data.input as Record<string, LegendRef[]>) ?? {});
	const KIND: Record<MatGroup, MatMedia> = { images: "image", videos: "video", audios: "audio" };
	for (const g of ["images", "videos", "audios"] as const) {
		(Array.isArray(input[g]) ? input[g] : []).forEach((ref, idx) => {
			if (!ref || (!ref.url && !ref.id)) return;
			const uri = (ref.id && (blobs[ref.id]?.localUri || assetsMap[ref.id]?.uri)) || ref.url || "";
			const url = ref.url || (ref.id && blobs[ref.id]?.url) || "";
			raw.push({
				key: `s:${ref.id || ref.url}`, media: KIND[g], name: ref.name || "", uri, url,
				id: ref.id, assetId: ref.assetId, voiceForAssetId: ref.voiceForAssetId, self: { group: g, idx },
			});
		});
	}
	// (3) 已记录的按 matOrder 序，未记录的按上面枚举序（旧序）补在后
	const order = Array.isArray(node.data.matOrder) ? node.data.matOrder : [];
	const pos = new Map(order.map((k, i) => [k, i] as const));
	const listed = raw.filter((r) => pos.has(r.key)).sort((x, y) => pos.get(x.key)! - pos.get(y.key)!);
	const unlisted = raw.filter((r) => !pos.has(r.key));
	const c: Record<MatMedia, number> = { image: 0, video: 0, audio: 0 };
	return [...listed, ...unlisted].map((r) => {
		const n = ++c[r.media];
		return { ...r, n, tag: `@${TAG_KIND[r.media]}${n}` };
	});
}

/**
 * 取某节点素材区的 @ 待选候选（listNodeMaterials 单点枚举：加入顺序 + 与图例/提交一致的 @tag 编号）。
 * 供提示词放大弹窗/面板编辑器输入 @ 时的待选框与胶囊渲染使用。
 */
export function getNodeMaterialItems(nodeId: string): { tag: string; name?: string; uri: string; media: MatMedia }[] {
	return listNodeMaterials(nodeId).map((e) => ({ tag: e.tag, name: e.name || undefined, uri: e.uri, media: e.media }));
}

type MatRef = { id?: string; url?: string; name?: string };

function setNodeInput(nodeId: string, mutate: (input: Record<string, MatRef[]>) => void): void {
	const cs = useCanvasStore.getState();
	const n = cs.nodes[nodeId];
	if (!n) return;
	const input = { ...((n.data.input as Record<string, MatRef[]>) || {}) };
	for (const k of Object.keys(input)) input[k] = Array.isArray(input[k]) ? [...input[k]] : [];
	mutate(input);
	useCanvasStore.setState({ nodes: { ...cs.nodes, [nodeId]: { ...n, data: { ...n.data, input } } } });
	useProjectStore.getState().scheduleAutoSave("canvas");
}

/** 把本地媒体文件上传成画布素材并追加到节点 input（图/视频/音频按组）。文本类忽略。 */
export async function addNodeMaterialFiles(nodeId: string, files: File[]): Promise<void> {
	const key = uploadKeys.node(nodeId);
	for (const file of files) {
		const kind = uploadKindFromFile(file);
		if (kind === "script") continue; // 仅媒体作素材
		let assetId: string;
		let displayUri: string;
		let localPath: string | null;
		useUploadStore.getState().begin(key); // 素材区显示占位符+转圈
		try {
			const up = await uploadMediaToCanvasAsset(file);
			assetId = up.assetId;
			displayUri = up.displayUri;
			localPath = up.localPath;
		} catch (err) {
			alert(`素材上传失败（未做 OSS 存储）：${err instanceof Error ? err.message : "未知错误"}`);
			continue;
		} finally {
			useUploadStore.getState().end(key);
		}
		const url = useProjectStore.getState().assetBlobs[assetId]?.url || ""; // 请求用公网 url
		const group = GROUP[kind];
		setNodeInput(nodeId, (input) => {
			const arr = input[group] || (input[group] = []);
			// 去重：同一资产（同 id 或同 url）不重复加入本节点素材区
			if (arr.some((m) => (assetId && m.id === assetId) || (url && m.url === url))) return;
			arr.push({ id: assetId, url, name: file.name });
		});
		syncNodeLegend(nodeId); // 添加素材同步加入图例前缀
		// 同时进「本地素材库」（origin=upload），供跨节点复用
		useLibraryStore.getState().addAsset({
			id: assetId, kind, name: file.name, uri: displayUri, serverAssetId: assetId,
			thumbnailUri: null, createdAt: new Date().toISOString(), deletedByUser: false, localPath, origin: "upload",
		});
	}
}

/** 从资产（资产助手/本地素材库）直接把一条垫图加到节点素材区（不新建节点）。 */
export function addNodeMaterialFromAsset(
	nodeId: string,
	asset: { id?: string; url?: string; name?: string; media?: MatMedia },
): void {
	const media = asset.media ?? "image";
	const group = GROUP[media];
	// 请求用公网 url：优先资产登记的 blob.url，回退传入 url
	const url = (asset.id && useProjectStore.getState().assetBlobs[asset.id]?.url) || asset.url || "";
	setNodeInput(nodeId, (input) => {
		const arr = input[group] || (input[group] = []);
		// 去重：同一资产（同 id 或同 url）不重复加入本节点素材区
		if (arr.some((m) => (asset.id && m.id === asset.id) || (url && m.url === url))) return;
		arr.push({ id: asset.id, url, name: asset.name });
	});
	syncNodeLegend(nodeId); // 添加素材同步加入图例前缀
}

/**
 * 输入 # 导入：把项目资产加入节点素材区并返回其 @tag + 素材数据（供提示词框立即插入胶囊）。
 * 已在本节点则复用。找不到返回 null。
 */
export function importAssetToNode(
	nodeId: string,
	cand: { assetId: string; blobId?: string; url?: string; name: string; uri: string },
): { tag: string; mat: ShotMaterial } | null {
	addNodeMaterialFromAsset(nodeId, { id: cand.blobId, url: cand.url, name: cand.name, media: "image" });
	const items = getNodeMaterialItems(nodeId);
	const it = items.find((x) => x.media === "image" && x.uri === cand.uri)
		?? items.find((x) => x.media === "image" && x.name === cand.name);
	if (!it) return null;
	return { tag: it.tag, mat: { id: it.tag, kind: "local", media: "image", name: it.name || cand.name, uri: it.uri || cand.uri } };
}

const MEDIA_OF_GROUP: Record<MatGroup, MatMedia> = { images: "image", videos: "video", audios: "audio" };

/**
 * 构造节点「素材图例」（`【素材图例】@Image1 是 张三；@Image1的声音参考@Audio1；`）。
 * 素材顺序/编号 = listNodeMaterials 单点枚举（加入顺序），与素材区显示、提交数组恒一致；
 * assetId/voiceForAssetId 供音频「声音参考」配对。
 * inputOverride：本次将要写入的 input（含新增/删后素材），传入则按更新后素材编号。
 */
export function buildNodeLegend(nodeId: string, inputOverride?: Record<string, LegendRef[]>): string {
	const mats: ShotMaterial[] = listNodeMaterials(nodeId, inputOverride).map((e) => ({
		id: e.key, kind: "local", name: e.name, uri: e.uri || e.url, media: e.media,
		assetId: e.assetId, voiceForAssetId: e.voiceForAssetId,
	}));
	return buildLegend(mats, false);
}

/** 当前素材加入顺序快照（listNodeMaterials 枚举序的 key 列表，供写回 node.data.matOrder） */
export function computeMatOrder(nodeId: string, inputOverride?: Record<string, LegendRef[]>): string[] {
	return listNodeMaterials(nodeId, inputOverride).map((e) => e.key);
}

/**
 * 素材增删后同步节点提示词图例：按**当前素材**整体重建图例（增即加、删即移，绝不留「是xxx」残句），
 * 删除时按 removed 一并重编号正文内联 @ 引用（removed.n=0 表示被删素材本就无编号，只重建不重编号）。
 * 同时把当前素材加入顺序落进 node.data.matOrder（新素材恒在尾部——「素材只往后加」的落库点）。
 * 读最新节点态再写回。返回是否发生写入（投影等调用方据此聚合 dirty）。
 */
export function syncNodeLegend(
	nodeId: string,
	removed?: { media: MatMedia; n: number },
	options?: { preserveExisting?: boolean },
): boolean {
	const cs = useCanvasStore.getState();
	const n = cs.nodes[nodeId];
	if (!n) return false;
	const prompt = typeof n.data.params.prompt === "string" ? (n.data.params.prompt as string) : "";
	// 添加素材：始终补/更新图例；删除素材：仅当提示词已有图例才重建（不给没图例的提示词硬塞），并重编号正文 @ 引用
	const legend = !removed || prompt.includes(LEGEND_START) ? buildNodeLegend(nodeId) : "";
	const next = applyLegend(prompt, legend, removed && removed.n > 0 ? removed : undefined, options);
	const matOrder = computeMatOrder(nodeId);
	const prev = Array.isArray(n.data.matOrder) ? n.data.matOrder : [];
	const orderChanged = matOrder.length !== prev.length || matOrder.some((k, i) => k !== prev[i]);
	if (next !== prompt || orderChanged) {
		useCanvasStore.setState({
			nodes: { ...cs.nodes, [nodeId]: { ...n, data: { ...n.data, matOrder, params: { ...n.data.params, prompt: next } } } },
		});
		useProjectStore.getState().scheduleAutoSave("canvas");
		return true;
	}
	return false;
}

/** 从节点 input 删除某条自加素材；同时清理提示词里对应的 @ 引用并重编号（保持前缀准确） */
export function removeNodeMaterial(nodeId: string, group: MatGroup, idx: number): void {
	const node = useCanvasStore.getState().nodes[nodeId];
	if (!node) return;
	const media = MEDIA_OF_GROUP[group];
	// 被删素材的 @ 编号按加入顺序单点枚举取（与素材区显示/图例/提交一致）；不在枚举内（无 url/id）则只删不重编号
	const entry = listNodeMaterials(nodeId).find((e) => e.self?.group === group && e.self.idx === idx);
	const removedN = entry?.n ?? 0;

	setNodeInput(nodeId, (input) => {
		const arr = input[group];
		if (Array.isArray(arr) && idx >= 0 && idx < arr.length) arr.splice(idx, 1);
	});

	// 同步图例（在 setNodeInput 之后重取节点，避免覆盖 input 变更）：按当前素材整体重建图例 + 重编号正文 @ 引用
	syncNodeLegend(nodeId, { media, n: removedN });
}

/**
 * 删除「上游连线素材」= 断开对应连线（素材随连线消失），并同步修正提示词 @ 引用重编号。
 * 与自加素材删除同语义（不入撤销栈）；被删素材编号按加入顺序单点枚举取（与素材区显示/提交收集一致）；
 * 该边不贡献媒体素材（如文本上游）时只断线。
 */
export function removeUpstreamMaterial(nodeId: string, edgeId: string): void {
	const cs = useCanvasStore.getState();
	const edge = cs.edges[edgeId];
	if (!edge || edge.target !== nodeId) return;
	const entry = listNodeMaterials(nodeId).find((e) => e.edgeId === edgeId);
	cs.removeEdge(edgeId);
	useProjectStore.getState().scheduleAutoSave("canvas");
	if (entry) syncNodeLegend(nodeId, { media: entry.media, n: entry.n });
}
