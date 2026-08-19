/**
 * viewAngleOp —— 「转视角」的入口与提交（碰 store 与画布命令；纯模板在 src/lib/viewAngle.ts）。
 *
 *  - viewAngleNode / viewAngleUri：唤起多角度编辑器（弹窗在 App 根，见 ViewAngleModal）。
 *  - submitViewAngle：右侧新建 image.gen 节点承载——节点入口=连线承接源图（与图像超分同构），
 *    灯箱入口=产物节点自带素材；提示词=图例 + 视角模板句式；随后 dispatch run 走标准生成管线
 *    （计费/进度/历史/换模型重跑全部继承；纯提示词路线，服务端零改动）。
 */
import { useCanvasStore } from "@/store/canvasStore";
import { useLibraryStore } from "@/store/libraryStore";
import { useProjectStore } from "@/store/projectStore";
import { dispatchCommand } from "@/command/dispatch";
import { avoidOverlap, makeNode, NODE_W } from "@/canvas/nodeFactory";
import { genId } from "@/lib/id";
import { syncNodeLegend } from "@/canvas/nodeMaterials";
import { openViewAngle, type ViewAngleSession } from "@/store/viewAngleStore";
import { SHOT_LABELS, type ViewAngleParams } from "@/lib/viewAngle";
import { fetchUriOf } from "@/canvas/annotate";
import { useConnectionStore } from "@/store/connectionStore";

/** 服务端 /raw 直读地址（预览位图兜底；未登录/无 id 时为空） */
function rawUrlOf(serverAssetId?: string): string | undefined {
	const base = useConnectionStore.getState().normalizedUrl();
	return base && serverAssetId ? `${base}/v1/assets/${serverAssetId}/raw` : undefined;
}

/** 画布图片节点 → 转视角（产物落节点右侧，连线承接源图） */
export function viewAngleNode(nodeId: string): void {
	const node = useCanvasStore.getState().nodes[nodeId];
	const resultAssetId = node?.data.resultAssetId;
	if (!node || !resultAssetId) return;
	const asset = useLibraryStore.getState().assets[resultAssetId];
	openViewAngle({
		source: { nodeId, name: asset?.name },
		previewUri: fetchUriOf(resultAssetId),
		previewFallbackUri: rawUrlOf(asset?.serverAssetId || resultAssetId),
	});
}

/** 灯箱等场景：只有显示 uri（凭三元映射反查资产；无公网 url 的图提交时明确报错） */
export function viewAngleUri(uri: string, name?: string): void {
	const blob = useProjectStore.getState().blobByUri(uri);
	openViewAngle({
		source: { uri, assetId: blob?.id, name: name || blob?.id },
		previewUri: blob?.localUri || uri,
		previewFallbackUri: rawUrlOf(blob?.id),
	});
}

/**
 * 提交：新建图片节点 + 视角提示词 + 立即运行。
 * 返回错误文案（null=成功）；modelKey 为空由调用方（弹窗）预先拦。
 */
export function submitViewAngle(
	session: ViewAngleSession,
	params: ViewAngleParams,
	custom: string,
	modelKey: string,
): string | null {
	const cs = useCanvasStore.getState();
	const src = session.source;
	const baseName = (src.name || "图片").replace(/\.[a-z0-9]+$/i, "");
	// ⚠ 提示词不在客户端（第193轮）：节点只带**可见的短参数描述**；真实提示词由服务端按
	// purpose "image.viewangle" + params.viewAngle 渲染（模板在管理端「提示词模板·转视角」）。
	const lensLabel = params.lens === "fisheye" ? " · 鱼眼" : params.lens === "dutch" ? " · 荷兰角" : "";
	const panLabel = (params.panX || params.panY) ? ` · 平移(${params.panX ?? 0}%,${params.panY ?? 0}%)` : "";
	const prompt = `转视角：水平${Math.round(params.az)}° 俯仰${Math.round(params.el)}° ${SHOT_LABELS[params.shot]}${lensLabel}${panLabel}`;

	// 落点：源节点右侧 / 视口中心
	let x: number;
	let y: number;
	const srcNode = src.nodeId ? cs.nodes[src.nodeId] : null;
	if (srcNode) {
		x = srcNode.x + srcNode.w + 64;
		y = srcNode.y;
	} else {
		const vp = cs.viewport;
		x = (-vp.x + window.innerWidth / 2) / vp.zoom - NODE_W / 2;
		y = (-vp.y + window.innerHeight / 2) / vp.zoom - 100;
	}
	let node = makeNode("image.gen", x, y);
	node = avoidOverlap(node, Object.values(cs.nodes));
	node.data.title = `视角-${baseName}`;
	node.data.params = {
		...node.data.params,
		model: modelKey,
		prompt,
		purpose: "image.viewangle",
		viewAngle: {
			az: params.az, el: params.el, shot: params.shot,
			panX: params.panX ?? 0, panY: params.panY ?? 0,
			...(params.lens ? { lens: params.lens } : {}),
			...(custom.trim() ? { custom: custom.trim() } : {}),
		},
		assetName: `${baseName}-视角`,
	};

	if (srcNode) {
		dispatchCommand({
			type: "spawnNodes",
			parentId: srcNode.id,
			nodes: [node],
			edges: [{ id: genId("edge"), kind: "dataflow", source: srcNode.id, sourcePort: "out", target: node.id, targetPort: "in" }],
		});
	} else {
		// 无节点源：产物节点自带素材（请求要公网 url——本地未传 OSS 的图明确拒绝）
		const blobs = useProjectStore.getState().assetBlobs;
		const url = (src.assetId && blobs[src.assetId]?.url) || (/^https?:/i.test(src.uri || "") ? src.uri! : "");
		if (!url) return "该图片没有可用的公网地址（尚未完成 OSS 上传），请从画布图片节点发起转视角";
		node.data.input = { images: [{ id: src.assetId, url, name: src.name || "原图" }] };
		dispatchCommand({ type: "addNode", node });
	}
	// 图例前缀（@Image1 是 xxx）与 matOrder 落库，提示词里的 @Image1 引用有据可查
	syncNodeLegend(node.id);
	dispatchCommand({ type: "run", nodeId: node.id });
	return null;
}
