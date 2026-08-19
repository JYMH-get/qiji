/**
 * annotate —— 图片标注的入口与收尾（碰 store 与网络；纯模型在 src/lib/annotation.ts）。
 *
 *  - annotateNode：画布图片节点唤起标注（产物节点再标注=带矢量继续编辑，写回原节点）。
 *  - annotateUri：灯箱等「只有显示 uri」的场景唤起标注（凭三元映射反查 assetId）。
 *  - finishAnnotation：合成图上传资产 → 新建图片节点 / 写回目标节点（矢量 doc 随节点落盘）。
 */
import { useCanvasStore } from "@/store/canvasStore";
import { useLibraryStore } from "@/store/libraryStore";
import { useProjectStore } from "@/store/projectStore";
import { openAnnotation, type AnnotationSession } from "@/store/annotationStore";
import { dispatchCommand } from "@/command/dispatch";
import { uploadMediaToCanvasAsset } from "@/canvas/nodeUpload";
import { avoidOverlap, makeNode, NODE_W } from "@/canvas/nodeFactory";
import { isWebviewLocalUri } from "@/lib/publicUrl";
import { sanitizeAnnotationDoc, type AnnotationDoc } from "@/lib/annotation";

/** 资产的最佳取字节 uri：本地/内联直用；远程优先已登记本地副本（与 shotGroupOps 同尺；转深度 depthify 也复用） */
export function fetchUriOf(assetId: string): string {
	const asset = useLibraryStore.getState().assets[assetId];
	const uri = asset?.uri || "";
	if (!uri) return "";
	if (!/^https?:/i.test(uri) || isWebviewLocalUri(uri)) return uri;
	const blob = useProjectStore.getState().blobByUri(uri);
	return blob?.localUri || uri;
}

/**
 * 画布图片节点 → 标注。产物节点（data.annotation 且原图资产还在）再标注时带既有矢量、
 * 完成写回本节点；否则按「以当前主图为原图」的新标注，产物落在节点右侧新建图片节点。
 */
export function annotateNode(nodeId: string): void {
	const node = useCanvasStore.getState().nodes[nodeId];
	const resultAssetId = node?.data.resultAssetId;
	if (!node || !resultAssetId) return;
	const lib = useLibraryStore.getState().assets;

	// 再编辑：原图资产仍在才走（原图没了矢量对不上底，退化为对合成图重新标注）
	const prior = node.data.annotation;
	const priorDoc = prior ? sanitizeAnnotationDoc(prior.doc) : null;
	if (prior?.sourceAssetId && priorDoc && lib[prior.sourceAssetId]) {
		const src = lib[prior.sourceAssetId];
		openAnnotation({
			source: { uri: fetchUriOf(src.id), assetId: src.id, name: src.name },
			doc: priorDoc,
			targetNodeId: nodeId,
		});
		return;
	}

	const asset = lib[resultAssetId];
	openAnnotation({
		source: { uri: fetchUriOf(resultAssetId), assetId: asset?.serverAssetId || resultAssetId, name: asset?.name },
		anchor: { x: node.x + node.w + 64, y: node.y },
	});
}

/** 灯箱等场景：只有显示 uri → 凭三元映射反查 assetId（查不到也可标注，仅少再编辑溯源） */
export function annotateUri(uri: string, name?: string): void {
	const blob = useProjectStore.getState().blobByUri(uri);
	openAnnotation({ source: { uri: blob?.localUri || uri, assetId: blob?.id, name } });
}

/**
 * 标注完成收尾：合成图上传资产（TP 前缀）→ 注册素材库 →
 * targetNodeId 有值=写回该节点（旧主图进堆叠历史，矢量随节点更新）；
 * 否则新建 image.gen 节点承载（anchor 缺省=当前视口中心，防重叠错位落点）。
 */
export async function finishAnnotation(session: AnnotationSession, doc: AnnotationDoc, blob: Blob): Promise<void> {
	const baseName = (session.source.name || session.source.assetId || "图片").replace(/\.[a-z0-9]+$/i, "");
	const file = new File([blob], `涂鸦-${baseName}.png`, { type: "image/png" });
	const up = await uploadMediaToCanvasAsset(file, "TP");
	useLibraryStore.getState().addAsset({
		id: up.assetId,
		kind: "image",
		name: file.name,
		uri: up.displayUri,
		serverAssetId: up.assetId,
		thumbnailUri: null,
		createdAt: new Date().toISOString(),
		deletedByUser: false,
		localPath: up.localPath,
	});
	const annotation = { sourceAssetId: session.source.assetId, doc };

	const cs = useCanvasStore.getState();
	const target = session.targetNodeId ? cs.nodes[session.targetNodeId] : null;
	if (target) {
		// 写回：与「上传自定义结果」同语义——旧主图归档进 resultHistory，堆叠可回看/切回
		const hist = [...(target.data.resultHistory || [])];
		if (target.data.resultAssetId && !hist.includes(target.data.resultAssetId)) hist.push(target.data.resultAssetId);
		if (!hist.includes(up.assetId)) hist.push(up.assetId);
		useCanvasStore.setState({
			nodes: {
				...cs.nodes,
				[target.id]: {
					...target,
					data: { ...target.data, resultAssetId: up.assetId, resultHistory: hist, annotation },
				},
			},
		});
		return;
	}

	// 新建节点：anchor（源节点右侧）优先；灯箱路径无 anchor → 当前视口中心
	let x: number;
	let y: number;
	if (session.anchor) {
		x = session.anchor.x;
		y = session.anchor.y;
	} else {
		const vp = cs.viewport;
		x = (-vp.x + window.innerWidth / 2) / vp.zoom - NODE_W / 2;
		y = (-vp.y + window.innerHeight / 2) / vp.zoom - 100;
	}
	let node = makeNode("image.gen", x, y);
	node = avoidOverlap(node, Object.values(cs.nodes));
	node.data.resultAssetId = up.assetId;
	node.data.resultHistory = [up.assetId];
	node.data.annotation = annotation;
	node.data.title = file.name.replace(/\.png$/i, "");
	dispatchCommand({ type: "addNode", node });
}
