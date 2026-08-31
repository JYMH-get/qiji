/**
 * canvasProjection —— 资产模式 → 画布的单向投影（「单数据源双视图」可行性验证）。
 *
 * 用户在资产模式（剧本页/资产工作台/视频分镜页）的操作都写入 projectStore：
 *   剧本原文 → scriptText；剧本分析 → characters/scenes/items/organisms/crowds（+ 各资产 prompt/image）；
 *   剧集分集 → episodes；智能拆分 → episode.shots；出图/出视频 → 资产 image / shot.storyboardUri / videoUri。
 *
 * `syncCanvasFromProject()` 把这些数据**幂等地投影成画布节点**——按 `node.data.sourceRef` 去重，
 * 仅**新增 / 就地更新**（保留用户在画布里挪动的位置 + 模型/参数等非投影字段），不删除。
 * **例外：资产不投影**——一个项目动辄几十个资产节点是画布卡顿主因，同步只投「全文 + 剧集 + 本集分镜流水线」；
 * 历史同步残留的资产投影节点（assetSplit / asset:*）会在下次同步时被清理（需要单个资产图时从资产助手拖入）。
 *
 * **触发方式：用户手动**（资产模式顶栏「同步到画布」按钮调用本函数），不再自动订阅。
 * 理由：投影会覆盖同名投影节点的提示词/结果字段，自动同步会悄悄盖掉用户在画布的进度；改为
 * 用户主动点击后，「覆盖」即为用户知情同意。画布里**用户手建/裂变的节点（无 sourceRef）永不被触碰**。
 *
 * 链路与节点类型完全复用第72轮的规范化节点（asset.split / image.gen / episode.split / smart.infer /
 * text.seed），故双端语义一致（提示词/格式化已对齐）。投影是**单向**（资产模式为真源）。
 */

import { useProjectStore } from "@/store/projectStore";
import { useCanvasStore } from "@/store/canvasStore";
import { isWebviewLocalUri } from "@/lib/publicUrl";
import { useLibraryStore } from "@/store/libraryStore";
import { syncNodeLegend } from "@/canvas/nodeMaterials";
import { makeNode, NODE_W, NODE_H } from "@/canvas/nodeFactory";
import { getNodeSpec } from "@/nodes/nodeSpecs";
import { SMART_INFER_MULTI_TPL, SMART_INFER_UNIFIED_TPL, SMART_INFER_UNIFIED_SINGLE_TPL } from "@/lib/smartInferPrompts";
import { genId } from "@/lib/id";
import type { CanvasNode, CanvasEdge, NodeRuntime } from "@/types";

const W = NODE_W;
const H = NODE_H;
const GY = 48;
const STEP_X = W + 120;
const COL0 = 0;
const COL1 = STEP_X; // 剧集分集操作节点列
const COL2 = STEP_X * 2; // 每集智能推理列
const COL3 = STEP_X * 3; // 分镜原文列（smart.infer，带推理）
const COL4 = STEP_X * 4; // 分镜故事板图列（同源模式=同源提示词节点列）
const COL5 = STEP_X * 5; // 分镜视频列（同源模式=图片列）
const COL6 = STEP_X * 6; // 同源模式：视频列
const ASSET_Y = 0;
const EPISODE_Y = 0; // 资产不再投影后，剧集流水线直接从顶部排布（旧值 2200 是给资产网格留位）

const DEFAULT_RUNTIME: NodeRuntime = { status: "idle", progress: 0, taskId: null, scheduledAt: null, error: null };

/** 把资产模式的媒体（URI）登记为画布素材，返回稳定 assetId（幂等：uri 变了才重登记） */
function regMedia(key: string, uri: string, name: string, kind: "image" | "video"): string {
	const assetId = `proj-${key}`;
	const lib = useLibraryStore.getState();
	// 优先本地副本显示（远程 https 直链会被 Tauri CSP 拦→裂图）；无本地副本则用原 uri，
	// 由 ResultView 的 useDisplayUri 兜底下载到本地再显示。
	const blob = useProjectStore.getState().blobByUri(uri);
	const showUri = blob?.localUri || uri;
	const ex = lib.assets[assetId];
	if (!ex || ex.uri !== showUri || (blob?.id && ex.serverAssetId !== blob.id)) {
		lib.addAsset({
			id: assetId, kind, name, uri: showUri, thumbnailUri: kind === "image" ? showUri : null,
			createdAt: new Date().toISOString(), deletedByUser: false, localPath: blob?.localPath ?? null,
			// 管理端真资产 id（id 是真理）：下游提交时优先凭 id 解析 OSS 直链，不依赖 url 缓存
			serverAssetId: blob?.id ?? ex?.serverAssetId ?? null,
			origin: "generated",
		});
	}
	// 显示一律走本地文件：投影拿到的还是远程 url（本地副本缺失）→ 趁 url 未过期立刻下载落地，
	// 完成后把库资产升级为本地 uri + 登记三元映射（否则节点显示依赖公网 url，链接过期即永久裂开）。
	// 注意排除 http://asset.localhost/... 本地伪域直链——它已是本地文件的显示态，无需（也不应）再下载。
	if (!blob?.localUri && /^https?:/i.test(showUri) && !isWebviewLocalUri(showUri)) {
		void import("@/services/assetPersist").then(async ({ saveRemoteAsset }) => {
			const saved = await saveRemoteAsset(assetId, showUri);
			if (!saved?.localUri) return;
			useProjectStore.getState().registerAssetBlob({ ...saved, srcUri: showUri });
			const lib2 = useLibraryStore.getState();
			const cur = lib2.assets[assetId];
			if (cur && cur.uri === showUri) {
				lib2.addAsset({ ...cur, uri: saved.localUri, thumbnailUri: kind === "image" ? saved.localUri : null, localPath: saved.localPath ?? null });
			}
		}).catch(() => { /* 非 Tauri/下载失败：保留远程 uri，由 ResultView 的 useDisplayUri 兜底 */ });
	}
	return assetId;
}

const textOut = (n: CanvasNode) => getNodeSpec(n.type)?.outputs[0]?.name ?? "text";
const textIn = (n: CanvasNode) => {
	const s = getNodeSpec(n.type);
	return s?.inputs.find((p) => p.formats.includes("text"))?.name ?? s?.inputs[0]?.name ?? "text";
};

/**
 * 读资产模式状态，幂等投影成画布节点 + 连线。返回是否有变更。
 * @param episodeIdArg 画布当前分集 id：只投影该集的分镜流水线（资产不投影），节点打 episodeRef 标签。
 *   **不删除其它分集**的投影节点（各集节点共存于 store，靠画布渲染过滤按当前分集隐藏 → 每集是独立画布、
 *   互不影响、也不卡）。传 undefined 用 store 的 canvasEpisodeId；解析不到则默认首集。
 */
export function syncCanvasFromProject(episodeIdArg?: string | null): boolean {
	const ps = useProjectStore.getState();
	const cs = useCanvasStore.getState();
	const csNodes = cs.nodes;
	const csEdges = cs.edges;

	// 解析「画布当前分集」：显式入参 > store canvasEpisodeId > 上次在视频页选中的集 > 首集（无分集则 null）
	const epList = ps.episodes || [];
	const wanted = episodeIdArg !== undefined ? episodeIdArg : (ps.canvasEpisodeId ?? ps.uiSnapshot?.video?.episodeId ?? null);
	const targetEpId = wanted && epList.some((e) => e.id === wanted) ? wanted : (epList[0]?.id ?? null);

	// 图视同源模式：投影走同源链路 `原文 → 同源提示词节点(text.seed) → 图片 + 视频 并联`
	//（同源提示词独立成节点承载，图/视频**不内置提示词**、运行时取上游同源节点文本——改一处两处生效），
	// 否则走双结果链路 `原文 → 故事板图 → 视频` 串联（现状）。切换模式后清理对方链路的节点/边。
	const sameSource = !!ps.mediaSettings?.imgVideoSameSource;

	// 资产不再投影（一个项目动辄几十个资产节点，是画布卡顿主因；需要单个资产图时从资产助手拖入）。
	// 清理历史同步残留的资产投影节点（assetSplit / asset:*）及其连线，让老画布也随本次同步瘦身。
	// 双结果模式下同时清理同源提示词投影节点（shotUni:*，切回双结果时同源节点退场）。
	const isAssetRef = (r?: string) => !!r && (r === "assetSplit" || r.startsWith("asset:"));
	const isStaleRef = (r?: string) => isAssetRef(r) || (!sameSource && !!r && r.startsWith("shotUni:"));
	const removeIds = new Set(Object.values(csNodes).filter((n) => isStaleRef(n.data.sourceRef)).map((n) => n.id));

	// 现有投影节点按 sourceRef 索引（排除待清理的资产节点，防止被 ensure 复活）
	const bySource = new Map<string, CanvasNode>();
	for (const n of Object.values(csNodes)) if (n.data.sourceRef && !removeIds.has(n.id)) bySource.set(n.data.sourceRef, n);
	const edgeSet = new Set(Object.values(csEdges).map((e) => `${e.source}>${e.target}`));

	const work = new Map<string, CanvasNode>(); // sourceRef → 节点（已有或新建）
	const isNew = new Set<string>();
	const newEdges: CanvasEdge[] = [];
	// 需删除的既有连线（切换同源/双结果模式时清理对方链路的边），key=`${source}>${target}`
	const removeEdgeKeys = new Set<string>();
	let dirty = false;

	const ensure = (sourceRef: string, type: string, x: number, y: number, fill: (d: CanvasNode["data"]) => void): CanvasNode => {
		let prior = work.get(sourceRef) || bySource.get(sourceRef);
		// 类型迁移：旧格式投影节点（如分镜原文 text.seed → 现在 smart.infer）——类型不符则删旧建新（落在投影列位）
		if (prior && prior.type !== type) {
			removeIds.add(prior.id);
			bySource.delete(sourceRef);
			prior = undefined;
		}
		if (prior) {
			const data = { ...prior.data, params: { ...prior.data.params }, input: { ...prior.data.input } };
			const before = JSON.stringify({ p: data.params.prompt, r: data.resultText, a: data.resultAssetId, i: data.input });
			fill(data);
			const after = JSON.stringify({ p: data.params.prompt, r: data.resultText, a: data.resultAssetId, i: data.input });
			const node = { ...prior, data };
			if (after !== before) dirty = true;
			work.set(sourceRef, node);
			return node;
		}
		const node = makeNode(type, x, y);
		node.data.sourceRef = sourceRef;
		fill(node.data);
		isNew.add(node.id);
		dirty = true;
		work.set(sourceRef, node);
		return node;
	};

	const connect = (a: CanvasNode, b: CanvasNode) => {
		const k = `${a.id}>${b.id}`;
		if (edgeSet.has(k)) return;
		edgeSet.add(k);
		newEdges.push({ id: genId("edge"), kind: "dataflow", source: a.id, sourcePort: textOut(a), target: b.id, targetPort: textIn(b) });
		dirty = true;
	};

	// 1. 剧本原文 → 文本种子
	let scriptNode: CanvasNode | null = null;
	if (ps.scriptText.trim()) {
		scriptNode = ensure("script", "text.seed", COL0, ASSET_Y, (d) => { d.params.prompt = ps.scriptText; d.resultText = ps.scriptText; });
	}

	// 2.（已移除）资产不再投影成画布节点——见上方 removeIds 说明。

	// 3+4. 全文 → 剧集分集 → 每集「智能推理」节点 → 该集每分镜一条流水线(文本→故事板图→视频)。
	//      逻辑：全文→剧集→分镜。智能推理基于已分好集的本集文案，是剧集分集的**下游**(每集一个)，非与之平级。
	type ProjMat = { id: string; assetId?: string; media?: "image" | "video" | "audio"; name?: string; uri: string; voiceForAssetId?: string };
	type ProjShot = { id: string; index?: number; scriptSegment?: string; prompt?: string; storyboardPrompt?: string; videoPrompt?: string; unifiedPrompt?: string; storyboardUri?: string; videoUri?: string; materials?: ProjMat[] };
	// 分镜垫素材 → 节点 input（图/视频/音频分组；故事板节点只取图像，视频节点取全部），供节点显示+下游引用。
	// ⚠ ref 键空间必须与画布「匹配素材」（assetMatch）完全一致，两侧才互认（判重/matOrder/素材编号）：
	//   id=**台账 blob id**（图生图按 id 取字节；勿写资产实体 id——键互不相认正是「再同步后画布编号错乱」的根源之一）、
	//   url=公网 url 优先（请求用；显示由 listNodeMaterials 凭 id 反查本地副本）、
	//   assetId=项目资产实体 id（音色「声音参考」按此配对）、voiceForAssetId 透传（音频归属角色）。
	const matToInput = (mats: ProjMat[] | undefined, imageOnly: boolean): Record<string, unknown> => {
		const blobOf = useProjectStore.getState().blobByUri;
		const images: any[] = [], videos: any[] = [], audios: any[] = [];
		for (const m of mats || []) {
			if (!m.uri) continue;
			const blob = blobOf(m.uri);
			const ref = {
				id: blob?.id, url: blob?.url || m.uri, name: m.name, assetId: m.assetId,
				...(m.voiceForAssetId ? { voiceForAssetId: m.voiceForAssetId } : {}),
			};
			const media = m.media || "image";
			if (media === "image") images.push(ref);
			else if (!imageOnly && media === "video") videos.push(ref);
			else if (!imageOnly && media === "audio") audios.push(ref);
		}
		const input: Record<string, unknown> = {};
		if (images.length) input.images = images;
		if (videos.length) input.videos = videos;
		if (audios.length) input.audios = audios;
		return input;
	};
	// 投影覆盖过 input 的媒体节点：入库后按画布自己的素材枚举重建图例 + 落 matOrder（见函数尾）
	const mediaSyncIds: string[] = [];
	const episodes = epList;
	const targetEp = episodes.find((e) => e.id === targetEpId) || null;
	if (episodes.length) {
		const epSplit = ensure("episodeSplit", "episode.split", COL1, EPISODE_Y, (d) => { d.params.prompt = ps.scriptText; });
		if (scriptNode) connect(scriptNode, epSplit);
		// 只投影「当前分集」：其智能推理节点 + 各分镜流水线；所有节点打 episodeRef 标签供清理/筛选（降低节点数与卡顿）
		if (targetEp) {
			const ep = targetEp;
			const epContent = [ep.title, ep.scriptText].filter(Boolean).join("\n");
			const shots = (ep.shots as ProjShot[]) || [];
			// 投影的分集级推理节点承载**整集**原文 → 显式带多分镜模板（同源模式=同源多卡；手动新建默认单分镜）
			const epTpl = sameSource ? SMART_INFER_UNIFIED_TPL : SMART_INFER_MULTI_TPL;
			const infer = ensure(`episode:${ep.id}`, "smart.infer", COL2, EPISODE_Y, (d) => { d.params.prompt = epContent; d.resultText = epContent; d.episodeRef = ep.id; d.params.templateId = epTpl; });
			connect(epSplit, infer);
			shots.forEach((sh, i) => {
				const y = EPISODE_Y + i * (H + GY);
				const n = sh.index ?? (i + 1); // 分镜号（用于命名 分镜n原文/故事板/视频，与裂变格式一致）
				const content = sh.scriptSegment || sh.prompt || "";
				// 原文节点=**智能推理节点**（分镜n原文，带推理功能）：内容既是展示也是推理输入，上游为分集智能推理
				// 节点 → 满足自跑重推理（SHOT_SCRIPT_TITLE_RE + 上游 smart.infer），与画布裂变的原文节点同构。
				// 同源模式：原文节点带同源·单卡模板，自跑重推理仍产同源提示词。
				const shotNode = ensure(`shot:${sh.id}`, "smart.infer", COL3, y, (d) => {
					d.title = `分镜${n}原文`; d.params.prompt = content; d.resultText = content; d.episodeRef = ep.id;
					if (sameSource) d.params.templateId = SMART_INFER_UNIFIED_SINGLE_TPL; else delete d.params.templateId;
				});
				connect(infer, shotNode);
				if (sameSource) {
					// 图视同源：同源提示词**独立成节点**（承载 unifiedPrompt）→ 图片 + 视频 并联。
					// 图/视频节点不内置提示词（运行时自动取上游同源节点文本）——改同源节点一处，图片与视频同时变。
					if (sh.unifiedPrompt || sh.storyboardUri || sh.videoUri) {
						const uPrompt = sh.unifiedPrompt || sh.prompt || "";
						const uni = ensure(`shotUni:${sh.id}`, "text.seed", COL4, y, (d) => {
							// 只写 prompt、不写 resultText（下游取文优先 resultText——写了它，画布上编辑 prompt 后下游仍拿旧值）
							d.title = `分镜${n}同源提示词`; d.params.prompt = uPrompt; d.episodeRef = ep.id;
						});
						connect(shotNode, uni);
						const sb = ensure(`shotSb:${sh.id}`, "image.gen", COL5, y, (d) => {
							d.title = `分镜${n}图片`;
							d.params.prompt = ""; // 不内置提示词：用上游同源节点文本（图例由入库后的 syncNodeLegend 统一补）
							d.input = matToInput(sh.materials, true); // 图片=图像生成，只取图像垫图
							d.episodeRef = ep.id; if (sh.storyboardUri) d.resultAssetId = regMedia(`sb-${sh.id}`, sh.storyboardUri, `分镜${n}图片`, "image");
						});
						connect(uni, sb);
						mediaSyncIds.push(sb.id);
						const vid = ensure(`shotVid:${sh.id}`, "video.gen", COL6, y, (d) => {
							d.title = `分镜${n}视频`;
							d.params.prompt = ""; // 不内置提示词：用上游同源节点文本（图例由入库后的 syncNodeLegend 统一补）
							d.input = matToInput(sh.materials, false); // 视频=图/视频/音频垫素材全取
							d.episodeRef = ep.id; if (sh.videoUri) d.resultAssetId = regMedia(`vid-${sh.id}`, sh.videoUri, `分镜${n}视频`, "video");
						});
						connect(uni, vid);
						mediaSyncIds.push(vid.id);
						// 清理双结果/旧同源并联链路残留的边：原文→图、原文→视频、图→视频（现行链路为 原文→同源→图/视频）
						removeEdgeKeys.add(`${shotNode.id}>${sb.id}`);
						removeEdgeKeys.add(`${shotNode.id}>${vid.id}`);
						removeEdgeKeys.add(`${sb.id}>${vid.id}`);
					}
				} else {
					// 双结果（现状）：原文 → 故事板图 → 视频 串联
					let prev = shotNode;
					if (sh.storyboardPrompt || sh.storyboardUri) {
						const sb = ensure(`shotSb:${sh.id}`, "image.gen", COL4, y, (d) => {
							d.title = `分镜${n}故事板`;
							d.params.prompt = sh.storyboardPrompt || sh.prompt || "";
							d.input = matToInput(sh.materials, true); // 故事板=图像生成，只取图像垫图
							d.episodeRef = ep.id; if (sh.storyboardUri) d.resultAssetId = regMedia(`sb-${sh.id}`, sh.storyboardUri, `分镜${n}故事板`, "image");
						});
						connect(prev, sb);
						mediaSyncIds.push(sb.id);
						prev = sb;
					}
					if (sh.videoPrompt || sh.videoUri) {
						const vid = ensure(`shotVid:${sh.id}`, "video.gen", COL5, y, (d) => {
							d.title = `分镜${n}视频`;
							d.params.prompt = sh.videoPrompt || "";
							d.input = matToInput(sh.materials, false); // 视频=图/视频/音频垫素材全取
							d.episodeRef = ep.id; if (sh.videoUri) d.resultAssetId = regMedia(`vid-${sh.id}`, sh.videoUri, `分镜${n}视频`, "video");
						});
						connect(prev, vid);
						mediaSyncIds.push(vid.id);
						// 清理同源链路残留的 原文→视频 并联边（切换回双结果时）
						removeEdgeKeys.add(`${shotNode.id}>${vid.id}`);
					}
				}
			});
		}
	}

	// 多画布：投影写入**当前激活画布**（canvasStore）。调用方（视频界面「同步本集到画布」）已先 switchCanvas
	// 到目标分集的独立画布，故这里只需把「资产 + 本集分镜」合并进当前画布即可（不跨画布、不删其它集）。
	if (ps.canvasEpisodeId !== targetEpId) useProjectStore.getState().setCanvasEpisodeId(targetEpId);

	// 冲突边清理（切换同源/双结果模式）：只删**既有**且命中 removeEdgeKeys 的边（新边不受影响）
	const staleEdgeIds = new Set<string>();
	if (removeEdgeKeys.size) {
		for (const [id, e] of Object.entries(csEdges)) {
			if (removeEdgeKeys.has(`${e.source}>${e.target}`)) staleEdgeIds.add(id);
		}
	}
	if (removeIds.size || staleEdgeIds.size) dirty = true;
	if (dirty) {
		// 应用：删除资产投影残留 → 合并新/更新节点 + 新边 + 为新节点 seed runtime
		const finalNodes: typeof csNodes = {};
		for (const [id, n] of Object.entries(csNodes)) if (!removeIds.has(id)) finalNodes[id] = n;
		const runtime = { ...cs.runtime };
		for (const id of removeIds) delete runtime[id];
		for (const node of work.values()) {
			finalNodes[node.id] = node;
			if (isNew.has(node.id)) runtime[node.id] = { ...DEFAULT_RUNTIME };
		}
		const finalEdges: typeof csEdges = {};
		for (const [id, e] of Object.entries(csEdges)) if (!removeIds.has(e.source) && !removeIds.has(e.target) && !staleEdgeIds.has(id)) finalEdges[id] = e;
		for (const e of newEdges) finalEdges[e.id] = e;
		// 分组成员级联：被删节点从分组 childIds 移除，空分组丢弃
		let groups = cs.groups;
		if (removeIds.size) {
			groups = {};
			for (const [gid, g] of Object.entries(cs.groups)) {
				const childIds = g.childIds.filter((id) => !removeIds.has(id));
				if (childIds.length) groups[gid] = childIds.length === g.childIds.length ? g : { ...g, childIds };
			}
		}
		useCanvasStore.setState({ nodes: finalNodes, edges: finalEdges, groups, runtime });
	}
	// 图例/matOrder 对齐（入库后统一跑，幂等无变化不写）：投影把 input 覆盖成了「表格素材序」，而画布节点的
	// 素材枚举含**上游连线素材**（如故事板图作垫图）且顺序由 matOrder 锁定——不按画布枚举重建图例，提示词里的
	// @ImageN 就与素材区/@ 待选/提交收集错位（表格图例编号 ≠ 画布编号，「无法一一对应」的画布侧根源，勿省略）。
	// 已知边界：表格提示词**正文**里手写的内联 @ 引用仍按表格编号（图例块整体重建为画布编号；推理产出通常无内联 @）。
	let legendDirty = false;
	// 投影可能在素材最前插入「上游故事板图」，同一个 @ImageN 已换了资产身份，不能按编号保留旧说明。
	for (const id of mediaSyncIds) if (syncNodeLegend(id, undefined, { preserveExisting: false })) legendDirty = true;
	return dirty || legendDirty;
}
