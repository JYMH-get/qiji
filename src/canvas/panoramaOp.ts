/**
 * panoramaOp —— 「720°全景」的入口与产物落库（碰 store 与画布命令）。
 *
 *  - panoramaNode：图片节点 → 右侧新建 image.gen 节点生成 equirect 全景
 *    （purpose "image.panorama"，前置提示词服务端模板渲染——客户端零提示词，与转视角同规）。
 *  - viewPanoramaNode：打开全景查看器（WebGL 拖动视角 + 单张/四/六/八/十二视图截取）。
 *  - savePanoSnapshots：截图产物落库——**懒上传**（本地暂存 LC 资产，请求引用时才补 OSS，
 *    第194轮全局上传规则）；单张→新图片节点，多张→分镜组节点（宫格承载）。
 */
import { useCanvasStore } from "@/store/canvasStore";
import { useLibraryStore } from "@/store/libraryStore";
import { dispatchCommand } from "@/command/dispatch";
import { avoidOverlap, makeNode, NODE_W } from "@/canvas/nodeFactory";
import { genId } from "@/lib/id";
import { syncNodeLegend } from "@/canvas/nodeMaterials";
import { uploadMediaToCanvasAsset } from "@/canvas/nodeUpload";
import { buildShotGroupNode } from "@/lib/shotGroup";
import { fetchUriOf } from "@/canvas/annotate";
import { openPanoViewer } from "@/store/panoStore";
import { useConnectionStore } from "@/store/connectionStore";
import { getChannelModelsForNodeType } from "@/services/adapters/channelAdapter";

/** 默认模型：gpt-image-2 家族优先（与转视角同策略） */
function defaultImageModel(): string {
	const models = getChannelModelsForNodeType("image.gen");
	const gpt = models.find((m) => m.familyId === "fam-gpt-image-2")
		?? models.find((m) => /gpt[- ]?image/i.test(`${m.id} ${m.label}`));
	return (gpt ?? models[0])?.id ?? "";
}

/**
 * 图片节点 → 转全景（第195轮定稿）：搭好「生成节点（默认 4K）→ 720全景查看节点」链，
 * **不自动运行**——用户在生成节点上选好模型/补充要求后自己点生成；结果一出，
 * 查看节点自动进入全景交互查看（跳过扭曲平面图）。
 */
export function panoramaNode(nodeId: string): void {
	const cs = useCanvasStore.getState();
	const node = cs.nodes[nodeId];
	const resultAssetId = node?.data.resultAssetId;
	if (!node || !resultAssetId) return;
	const modelKey = defaultImageModel(); // 默认锁 gpt-image-2 家族；节点上可换
	const asset = useLibraryStore.getState().assets[resultAssetId];
	const baseName = (asset?.name || "图片").replace(/\.[a-z0-9]+$/i, "");

	let gen = makeNode("image.gen", node.x + node.w + 64, node.y);
	gen = avoidOverlap(gen, Object.values(cs.nodes));
	gen.data.title = `全景-${baseName}`;
	gen.data.params = {
		...gen.data.params,
		...(modelKey ? { model: modelKey } : {}),
		purpose: "image.panorama",
		panorama: {}, // 全景标记（查看入口判定）+ 服务端渲染参数容器（custom 后续可加）
		aspect: "16:9",
		resolution: "4k", // 自动选用 4K 画质（模型未开放 4K 档时提交前归一到开放集）
		prompt: "720°全景：以原图为正前方扩展为 equirect 2:1 全景",
		assetName: `${baseName}-全景`,
	};
	// 720全景查看节点（生成节点右侧，连线承接结果；生成完成自动进入全景查看）
	let viewer = makeNode("pano.view", gen.x + gen.w + 64, gen.y);
	viewer.w = 440;
	viewer.h = 260;
	viewer = avoidOverlap(viewer, [...Object.values(cs.nodes), gen]);
	viewer.data.title = `720°全景-${baseName}`;

	dispatchCommand({
		type: "spawnNodes",
		parentId: node.id,
		nodes: [gen, viewer],
		edges: [
			{ id: genId("edge"), kind: "dataflow", source: node.id, sourcePort: "out", target: gen.id, targetPort: "in" },
			{ id: genId("edge"), kind: "dataflow", source: gen.id, sourcePort: "out", target: viewer.id, targetPort: "in" },
		],
	});
	syncNodeLegend(gen.id);
}

/** 图片节点 → 全景查看器（任意图片可开——非 2:1 图会被水平回卷采样，观感由用户判断） */
export function viewPanoramaNode(nodeId: string): void {
	const node = useCanvasStore.getState().nodes[nodeId];
	const resultAssetId = node?.data.resultAssetId;
	if (!node || !resultAssetId) return;
	const asset = useLibraryStore.getState().assets[resultAssetId];
	const base = useConnectionStore.getState().normalizedUrl();
	const sid = asset?.serverAssetId || resultAssetId;
	openPanoViewer({
		uri: fetchUriOf(resultAssetId),
		fallbackUri: base && sid && !sid.startsWith("LC-") ? `${base}/v1/assets/${sid}/raw` : undefined,
		name: asset?.name,
		sourceNodeId: nodeId,
	});
}

/**
 * 截图产物落库：懒上传本地暂存 → 单张=新图片节点 / 多张=分镜组节点（源节点右侧）。
 * 返回错误文案（null=成功）。
 */
export async function savePanoSnapshots(
	blobs: Blob[],
	labels: string[],
	opts: { sourceNodeId?: string; baseName?: string; setTitle: string },
): Promise<string | null> {
	if (!blobs.length) return "没有可保存的视角";
	const cs = useCanvasStore.getState();
	const src = opts.sourceNodeId ? cs.nodes[opts.sourceNodeId] : null;
	let x: number;
	let y: number;
	if (src) {
		x = src.x + src.w + 64;
		y = src.y;
	} else {
		const vp = cs.viewport;
		x = (-vp.x + window.innerWidth / 2) / vp.zoom - NODE_W / 2;
		y = (-vp.y + window.innerHeight / 2) / vp.zoom - 100;
	}
	const base = (opts.baseName || "全景").replace(/\.[a-z0-9]+$/i, "");
	const ids: string[] = [];
	try {
		for (let i = 0; i < blobs.length; i++) {
			const name = `${base}-${labels[i] || `视角${i + 1}`}.png`;
			const file = new File([blobs[i]], name, { type: "image/png" });
			const up = await uploadMediaToCanvasAsset(file, "TP"); // 懒上传：本地暂存，引用时才补 OSS
			useLibraryStore.getState().addAsset({
				id: up.assetId,
				kind: "image",
				name,
				uri: up.displayUri,
				serverAssetId: null, // LC 本地暂存资产：尚无服务端身份（补传后凭 srcUri 缓存换真 id）
				thumbnailUri: null,
				createdAt: new Date().toISOString(),
				deletedByUser: false,
				localPath: up.localPath,
			});
			ids.push(up.assetId);
		}
	} catch (err) {
		return `视角保存失败：${err instanceof Error ? err.message : "未知错误"}`;
	}

	if (ids.length === 1) {
		let node = makeNode("image.gen", x, y);
		node = avoidOverlap(node, Object.values(cs.nodes));
		node.data.resultAssetId = ids[0];
		node.data.resultHistory = [...ids];
		node.data.title = `${base}-${labels[0] || "视角"}`;
		dispatchCommand({ type: "addNode", node });
		return null;
	}
	let group = buildShotGroupNode({ assets: ids, x, y, title: `${base}-${opts.setTitle}` });
	group = avoidOverlap(group, Object.values(cs.nodes));
	dispatchCommand({ type: "createShotGroup", node: group });
	return null;
}
